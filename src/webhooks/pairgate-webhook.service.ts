import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { BillsService } from '../bills/bills.service';
import { ExamsService } from '../exams/exams.service';
import { BettingService } from '../betting/betting.service';

// Pairgate doesn't document a retry-tolerance window for how old a
// signature's timestamp is allowed to be — 5 minutes is a defensive,
// conventional choice (same order of magnitude Stripe/Paystack-style
// webhook verifiers typically use), not a documented Pairgate requirement.
const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

export interface WebhookVerificationResult {
  isValid: boolean;
  payload?: any;
}

/**
 * Generic receiver for every Pairgate category this app now uses (airtime/
 * data/tv/electricity via BillsService, WAEC/NECO via ExamsService, betting
 * via BettingService) — one webhook, dispatched by looking up the
 * Transaction that `reference_code` (Pairgate's own generated id, stored as
 * Transaction.providerReference by each service's purchase() method) points
 * to, and reading its `type` to know which service owns resolving it. New
 * async Pairgate categories added later plug into the switch below rather
 * than needing their own webhook route.
 *
 * Signature scheme confirmed against pairgate.com/developers/webhooks on
 * 2026-09-13 (see project doc claude/pairgate-api-full-reference.md):
 * `X-Pairgate-Signature` = hex HMAC-SHA256 of `timestamp + "." + raw_body`,
 * keyed with a webhook secret from Pairgate's own dashboard
 * (PAIRGATE_WEBHOOK_SECRET — a NEW env var, not the same as PAIRGATE_API_KEY
 * used for outbound calls). `X-Pairgate-Timestamp` is Unix seconds.
 *
 * Delivery guarantee is weak (docs: "if your server does not return a 2xx
 * response, the webhook is dropped and logged" — no documented retry), so
 * this is deliberately NOT the only path to resolving a PROCESSING
 * transaction: BillsService.checkStatus / ExamsService.checkStatus /
 * BettingService.checkStatus all poll /transaction/status independently as
 * a reconciliation fallback if this webhook never arrives.
 */
@Injectable()
export class PairgateWebhookService {
  private readonly logger = new Logger(PairgateWebhookService.name);

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private wallet: WalletService,
    private bills: BillsService,
    private exams: ExamsService,
    private betting: BettingService,
  ) {}

  verifySignature(
    signatureHeader: string | undefined,
    timestampHeader: string | undefined,
    rawBody: Buffer | string,
  ): WebhookVerificationResult {
    const secret = this.config.get<string>('PAIRGATE_WEBHOOK_SECRET');
    if (!secret) {
      this.logger.error('PAIRGATE_WEBHOOK_SECRET is not set — rejecting all Pairgate webhooks');
      return { isValid: false };
    }
    if (!signatureHeader || !timestampHeader) return { isValid: false };

    const timestampMs = Number(timestampHeader) * 1000;
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > WEBHOOK_TIMESTAMP_TOLERANCE_MS) {
      this.logger.warn('Pairgate webhook rejected — timestamp missing or outside tolerance window');
      return { isValid: false };
    }

    const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const expected = createHmac('sha256', secret).update(`${timestampHeader}.${bodyStr}`).digest('hex');

    // Lengths must match before timingSafeEqual — it throws on a length
    // mismatch rather than returning false, and a signature header of the
    // wrong length is itself just an invalid signature, not a crash.
    const expectedBuf = Buffer.from(expected, 'hex');
    const givenBuf = Buffer.from(signatureHeader, 'hex');
    const isValid =
      expectedBuf.length === givenBuf.length && timingSafeEqual(expectedBuf, givenBuf);

    if (!isValid) {
      this.logger.warn('Pairgate webhook signature mismatch');
      return { isValid: false };
    }
    return { isValid: true, payload: JSON.parse(bodyStr) };
  }

  async handle(payload: any) {
    const referenceCode: string | undefined = payload?.reference_code;
    const status: string = (payload?.status ?? '').toString().toLowerCase();
    const message: string | undefined = payload?.message;
    // Field-naming inconsistency across categories, same as the purchase
    // responses these mirror — check every shape Pairgate might use rather
    // than one field name.
    const pin: string | undefined = payload?.pin ?? payload?.item?.pin ?? payload?.plan?.pin;

    if (!referenceCode) {
      this.logger.warn(`Pairgate webhook missing reference_code — ignoring. Payload: ${JSON.stringify(payload)}`);
      return { received: true };
    }

    const transaction = await this.prisma.transaction.findFirst({
      where: { providerReference: referenceCode },
    });
    if (!transaction) {
      this.logger.warn(`Pairgate webhook for unknown reference_code ${referenceCode} — no matching transaction`);
      return { received: true };
    }
    if (transaction.status !== 'PROCESSING') {
      // Already resolved (by this same webhook arriving twice — no
      // documented dedup from Pairgate — or by a status poll that got there
      // first). Idempotent no-op, not an error.
      return { received: true };
    }

    const isSuccess = status === 'success' || status === 'successful' || status === 'completed';
    const isFailed = status === 'failed' || status === 'declined' || status === 'error';

    if (isFailed) {
      this.logger.warn(`Pairgate webhook: transaction ${transaction.id} failed (${message}) — reversing debit`);
      await this.wallet.reversePendingDebit(transaction.id, message ?? 'Pairgate purchase failed (webhook)');
      return { received: true };
    }

    if (!isSuccess) {
      // Still pending / some other non-final status — nothing to do yet.
      return { received: true };
    }

    switch (transaction.type) {
      case 'EXAM_PIN':
        if (!pin) {
          this.logger.warn(`Pairgate webhook: exam pin success for ${transaction.id} but no pin in payload`);
          return { received: true };
        }
        await this.exams.resolveWebhookSuccess(transaction.id, pin, message);
        break;
      case 'ELECTRICITY':
        await this.bills.resolveWebhookSuccess(transaction.id, pin, message);
        break;
      case 'BETTING':
        await this.betting.resolveWebhookSuccess(transaction.id, message);
        break;
      case 'AIRTIME':
      case 'DATA':
      case 'TV_SUBSCRIPTION':
        // These are synchronous on Pairgate — purchase() already resolved
        // them to SUCCESS/FAILED without ever needing a webhook. A webhook
        // arriving for one anyway (e.g. Pairgate sends one for every
        // category regardless) is harmless — nothing left PROCESSING to
        // update, but this transaction is by construction already past
        // PROCESSING for those types (see the `!== 'PROCESSING'` guard
        // above), so this branch is effectively unreachable and only here
        // for completeness/documentation.
        break;
      default:
        this.logger.warn(
          `Pairgate webhook: success for transaction ${transaction.id} of unhandled type ${transaction.type}`,
        );
    }

    return { received: true };
  }
}
