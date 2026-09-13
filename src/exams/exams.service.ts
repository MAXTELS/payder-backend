import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { VtpassProvider } from '../bills/providers/vtpass.provider';
import { PairgateEducationProvider, PairgateExamType } from './providers/pairgate-education.provider';
import { EmailService } from '../common/email/email.service';
import { renderEmailHtml, paragraphHtml, pinBoxHtml } from '../common/email/email-template';
import { verifyTransactionPin } from '../common/security/transaction-pin.util';
import { BuyExamPinDto } from './dto/buy-exam-pin.dto';

// PAYDER's flat portal charge on top of Pairgate's own real per-pin price —
// added on top of the real provider price and baked into the single total
// the customer sees and pays. Never shown as its own line item and the
// customer has no way to change it.
//
// 2026-09-13: now applies UNIFORMLY to both WAEC and NECO (Jude's explicit
// instruction, superseding the earlier 2026-09 decision below to exempt
// NECO). That earlier decision was conditioned on NECO having no live
// aggregator — the admin set NECO's sell price directly, already inclusive
// of whatever margin they wanted, so a second ₦1,000 on top would have
// double-charged the margin. Now that NECO is fulfilled live through
// Pairgate's real education API (same as WAEC), that condition no longer
// holds, and the ₦1,000 markup applies the same way it always did for WAEC.
const EXAM_PIN_MARKUP = 1000;

// Pairgate has no pricing/quote endpoint for education (confirmed against
// pairgate.com/developers/education-purchase) — the ONLY place a real
// per-pin price is ever exposed is inside an actual purchase's own
// response (`unit_price`). getPricing() below therefore reads a CACHED
// price from ProductCatalog rather than asking Pairgate live, and
// buyExamPin self-heals that cache from every real purchase's actual
// unit_price — so the cache converges on reality after the very first live
// purchase of each exam type, rather than depending on staying accurate
// forever. This generalizes what used to be a NECO-only "admin sets an
// arbitrary price" pattern (back when NECO had no live aggregator at all)
// into "cache of Pairgate's real price, self-correcting, admin can also
// override it" for both WAEC and NECO alike.
//
// Seed values are last-known-real-ish defaults to have *something*
// sensible showing before the very first live Pairgate purchase updates
// them — NOT guaranteed accurate. Run one real purchase of each (or use the
// admin price routes to set them from Pairgate's dashboard/support) right
// after deploying this to get both onto real numbers immediately.
const EXAM_PRODUCT_PROVIDER_NAME = 'pairgate-education';
const EXAM_DEFAULT_SEED_PRICE: Record<PairgateExamType, number> = {
  waec: 1000,
  neco: 900,
};

/**
 * Exam e-pin sales (WAEC result-checker, NECO result-checker, JAMB e-PIN).
 * Deliberately scoped down from "register for JAMB/Post-UTME" to "sell the
 * e-pin the candidate needs" — actual UTME/DE registration requires the
 * candidate to appear in person at a JAMB-accredited CBT centre and cannot
 * be done via API. See architecture doc §5.5 for the full explanation.
 *
 * WAEC and NECO are priced ENTIRELY server-side (see getPricing) — the
 * customer is never able to type or influence the amount for those two.
 * JAMB is not offered by Pairgate's education category at all (confirmed —
 * only waec/neco/nabt exist there) and stays on VTpass, untouched, still
 * trusting the client-supplied amount as it always has.
 *
 * 2026-09-13: WAEC and NECO both moved from VTpass (WAEC) / manual admin
 * fulfillment (NECO — no aggregator sold it before) onto Pairgate's real
 * education API, per Jude's explicit request to wire both through Pairgate
 * with a uniform ₦1,000 portal charge. Pairgate's purchase response never
 * carries the pin synchronously (`pin` is always null — see
 * PairgateEducationProvider's header comment) — both exam types are now
 * left PROCESSING after a successful purchase, exactly the same "we're
 * sourcing this, check back shortly" shape NECO already used for its old
 * manual-fulfillment flow, resolved later by the Pairgate webhook (backend/
 * src/webhooks/pairgate-webhook.*) or a client poll of the new
 * GET /exams/pins/:id/status route (checkStatus below).
 */
@Injectable()
export class ExamsService {
  constructor(
    private prisma: PrismaService,
    private wallet: WalletService,
    private vtpass: VtpassProvider,
    private pairgateEducation: PairgateEducationProvider,
    private email: EmailService,
  ) {}

  /** Emails the finished pin to the buyer — best-effort, mirrors the pattern
   * used for withdrawal/funding notifications (EmailService itself never
   * throws, so this can't turn a successful purchase into a failed one).
   * [deliveryEmail] is the address the customer typed on the exam-pins form
   * (pre-filled with, but editable from, their account email) — falls back
   * to the account email if that came back empty for any reason. */
  private async emailPin(userId: string, examType: string, pin: string, deliveryEmail?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, firstName: true },
    });
    if (!user) return;
    const to = deliveryEmail?.trim() || user.email;
    const examLabel = examType.toUpperCase();
    await this.email.send({
      to,
      subject: `PAYDER — your ${examLabel} pin`,
      text:
        `Hi ${user.firstName},\n\nYour ${examLabel} result-checker pin is ready:\n\n` +
        `${pin}\n\nYou can also find this any time in the app under Transaction history.\n\n` +
        `Thank you for using PAYDER.`,
      html: renderEmailHtml({
        heading: `Your ${examLabel} pin is ready`,
        bodyHtml:
          paragraphHtml(`Hi ${user.firstName},`) +
          paragraphHtml(`Your ${examLabel} result-checker pin is ready — here it is:`) +
          pinBoxHtml(pin) +
          paragraphHtml(
            'You can also find this any time in the app under <strong>Transaction history</strong>.',
          ) +
          paragraphHtml('Thank you for using PAYDER.'),
      }),
    });
  }

  /**
   * Finds (or, on first-ever call, creates) the ProductCatalog row caching
   * a given exam type's real per-pin price. See this file's header comment
   * for why this cache exists at all (no live Pairgate quote endpoint) and
   * how it self-heals. costPrice and sellPrice are kept identical here —
   * both just track "what Pairgate actually charges PAYDER right now" (or
   * an admin override); the ₦1,000 customer-facing markup is added
   * separately in getPricing/buyExamPin and is never stored in this row.
   */
  private async getOrCreateExamProduct(examType: PairgateExamType) {
    const provider = await this.prisma.provider.upsert({
      where: { name: EXAM_PRODUCT_PROVIDER_NAME },
      update: {},
      create: { name: EXAM_PRODUCT_PROVIDER_NAME, type: 'VTU', isActive: true, priority: 0 },
    });
    const variationCode = `${examType}-exam-pin`;
    return this.prisma.productCatalog.upsert({
      where: { providerId_variationCode: { providerId: provider.id, variationCode } },
      update: {},
      create: {
        providerId: provider.id,
        category: 'exam',
        variationCode,
        name: `${examType.toUpperCase()} result-checker pin`,
        costPrice: EXAM_DEFAULT_SEED_PRICE[examType],
        sellPrice: EXAM_DEFAULT_SEED_PRICE[examType],
        isActive: true,
      },
    });
  }

  /** Self-heal step: after every real Pairgate purchase, overwrite the
   * cached price with whatever Pairgate actually charged for that one pin —
   * see this file's header comment. No-ops silently if Pairgate didn't
   * return a unit_price for some reason (defensive; that field is
   * documented as always present on a real, non-test-mode purchase). */
  private async refreshExamProductPrice(examType: PairgateExamType, unitPrice?: number) {
    if (unitPrice === undefined || Number.isNaN(unitPrice)) return;
    const product = await this.getOrCreateExamProduct(examType);
    await this.prisma.productCatalog.update({
      where: { id: product.id },
      data: { costPrice: unitPrice, sellPrice: unitPrice },
    });
  }

  /** Admin dashboard read: what an exam pin is currently cached at (and
   * costs PAYDER). Kept under the same "neco-price" naming/route the admin
   * dashboard already has wired up (examType now selects which one). */
  async getNecoPriceConfig(examType: PairgateExamType = 'neco') {
    const product = await this.getOrCreateExamProduct(examType);
    return {
      sellPrice: product.sellPrice.toFixed(2),
      costPrice: product.costPrice.toFixed(2),
    };
  }

  /** Admin dashboard write: force-sets an exam type's cached price — useful
   * to seed a real value immediately after deploying, rather than waiting
   * for the first live purchase to self-heal it. Takes effect on the very
   * next pricing lookup/purchase. */
  async setNecoPrice(sellPrice: number, costPrice?: number, examType: PairgateExamType = 'neco') {
    const product = await this.getOrCreateExamProduct(examType);
    const updated = await this.prisma.productCatalog.update({
      where: { id: product.id },
      data: {
        sellPrice,
        ...(costPrice !== undefined ? { costPrice } : {}),
      },
    });
    return { sellPrice: updated.sellPrice.toFixed(2), costPrice: updated.costPrice.toFixed(2) };
  }

  /**
   * The price a customer would be charged for a given exam type right now —
   * used both by the "pricing preview" the frontend shows before purchase
   * and internally by buyExamPin so the two can never drift apart.
   */
  async getPricing(examType: 'waec' | 'neco' | 'jamb') {
    if (examType === 'jamb') {
      // Not offered by Pairgate's education category at all — still VTpass,
      // and the client still picks an amount for this one (unchanged).
      return { examType, realPrice: null, markup: '0.00', totalPrice: null, variationCode: null };
    }

    const product = await this.getOrCreateExamProduct(examType);
    const realPrice = Number(product.sellPrice);
    const markup = EXAM_PIN_MARKUP;

    return {
      examType,
      realPrice: realPrice.toFixed(2),
      markup: markup.toFixed(2),
      totalPrice: (realPrice + markup).toFixed(2),
      variationCode: null,
    };
  }

  async buyExamPin(userId: string, dto: BuyExamPinDto, idempotencyKey: string) {
    // Checked once here (ahead of the jamb delegation just below) so both
    // exam-pin purchase paths require a transaction PIN — buyJambPin is
    // only ever reached through this method, never called directly.
    const pinCheckUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { transactionPinHash: true },
    });
    if (!pinCheckUser) throw new NotFoundException('User not found');
    await verifyTransactionPin(pinCheckUser, dto.pin);

    if (dto.examType === 'jamb') {
      return this.buyJambPin(userId, dto, idempotencyKey);
    }

    // waec / neco: the backend is the ONLY source of the amount — dto.amount
    // is ignored entirely (it isn't even accepted by the DTO for these two)
    // so there is no way for a client to influence what gets debited.
    const examType = dto.examType as PairgateExamType;
    const pricing = await this.getPricing(examType);
    const realPrice = Number(pricing.realPrice);
    const totalCharge = pricing.totalPrice!;

    const transaction = await this.wallet.debitWalletForPurchase({
      userId,
      amount: totalCharge,
      type: 'EXAM_PIN',
      idempotencyKey,
      metadata: {
        examType: dto.examType,
        realPrice: realPrice.toFixed(2),
        markup: pricing.markup,
        // Carried through so a confirmation email defaults to whatever the
        // customer typed here.
        deliveryEmail: dto.email?.trim() || undefined,
      },
    });

    // Already processed (idempotent replay) — normalize the same shape a
    // fresh purchase below would return, rather than the raw stored row.
    if (transaction.status !== 'PENDING') {
      const meta = (transaction.metadata as Record<string, unknown> | null) ?? {};
      return {
        transactionId: transaction.id,
        status: transaction.status,
        pin: (meta.pin as string | null) ?? null,
      };
    }

    const result = await this.pairgateEducation.purchase({ requestId: transaction.id, examType });
    // Self-heal the cached price from whatever Pairgate actually charged
    // for this one real pin — see this file's header comment. Fire-and-
    // forget-ish (awaited, but its own failure shouldn't fail the purchase
    // that already succeeded/failed above).
    await this.refreshExamProductPrice(examType, result.unitPrice).catch(() => undefined);

    if (result.status === 'failed') {
      const reversed = await this.wallet.reversePendingDebit(
        transaction.id,
        result.message ?? 'Exam pin purchase failed',
      );
      return { transactionId: reversed.id, status: reversed.status, pin: null };
    }

    // Pairgate never returns the pin synchronously (see provider's header
    // comment) — left PROCESSING, same "we're sourcing this, check back
    // shortly" shape NECO's old manual-fulfillment flow already used.
    // Resolved later by the Pairgate webhook or GET /exams/pins/:id/status.
    const updated = await this.prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        status: 'PROCESSING',
        providerReference: result.providerReference,
        metadata: {
          ...(transaction.metadata as object),
          providerMessage: result.message,
          fulfillment: 'pairgate',
          note: `Your ${examType.toUpperCase()} pin is being generated and will appear here shortly.`,
          pin: null,
        },
      },
    });
    return { transactionId: updated.id, status: updated.status, pin: null };
  }

  /**
   * Polled by the client while an exam-pin purchase sits PROCESSING
   * (Pairgate's purchase response never carries the pin synchronously — see
   * PairgateEducationProvider's header comment). Mirrors
   * BillsService.checkStatus's shape exactly. JAMB purchases never reach
   * PROCESSING via this path (VTpass's WAEC-style purchase either fully
   * succeeds or fails synchronously — see buyJambPin), so this only ever
   * has real work to do for waec/neco.
   */
  async checkStatus(userId: string, transactionId: string) {
    const transaction = await this.prisma.transaction.findFirst({
      where: { id: transactionId, userId },
    });
    if (!transaction) {
      throw new NotFoundException('Transaction not found');
    }
    if (transaction.status !== 'PROCESSING' || !transaction.providerReference) {
      return transaction;
    }

    const result = await this.pairgateEducation.requery(transaction.providerReference);

    if (result.status === 'failed') {
      return this.wallet.reversePendingDebit(
        transaction.id,
        result.message ?? 'Exam pin purchase failed (requery)',
      );
    }
    if (result.status === 'success' && result.pin) {
      const meta = (transaction.metadata as Record<string, unknown> | null) ?? {};
      const updated = await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'SUCCESS',
          completedAt: new Date(),
          metadata: { ...meta, providerMessage: result.message, pin: result.pin },
        },
      });
      const examType = (meta.examType as string) ?? 'exam';
      const deliveryEmail = meta.deliveryEmail as string | undefined;
      await this.emailPin(userId, examType, result.pin, deliveryEmail);
      return updated;
    }
    return transaction; // still pending
  }

  /**
   * Called by the Pairgate webhook handler (backend/src/webhooks/
   * pairgate-webhook.service.ts) when a PROCESSING exam-pin purchase's pin
   * finally arrives asynchronously — the primary path, with checkStatus
   * above (client polling) as the reconciliation fallback. No-ops if
   * already resolved by whichever path got there first — same dedup
   * reasoning as BillsService.resolveWebhookSuccess.
   */
  async resolveWebhookSuccess(transactionId: string, pin: string, message?: string) {
    const transaction = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!transaction || transaction.status !== 'PROCESSING') return transaction;
    const meta = (transaction.metadata as Record<string, unknown> | null) ?? {};
    const updated = await this.prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        status: 'SUCCESS',
        completedAt: new Date(),
        metadata: { ...meta, providerMessage: message, pin },
      },
    });
    const examType = (meta.examType as string) ?? 'exam';
    const deliveryEmail = meta.deliveryEmail as string | undefined;
    await this.emailPin(transaction.userId, examType, pin, deliveryEmail);
    return updated;
  }

  /** Same "no customer-facing phone field" change as buyExamPin above — see
   * that method's comment. JAMB stays on VTpass (Pairgate's education
   * category doesn't offer it — confirmed against
   * pairgate.com/developers/education-providers), otherwise unchanged from
   * the original scaffold. */
  private async buyJambPin(userId: string, dto: BuyExamPinDto, idempotencyKey: string) {
    if (!dto.amount) {
      throw new BadRequestException('amount is required for JAMB pins');
    }

    const buyer = await this.prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
    if (!buyer) throw new NotFoundException('User not found');

    const transaction = await this.wallet.debitWalletForPurchase({
      userId,
      amount: dto.amount,
      type: 'EXAM_PIN',
      idempotencyKey,
      metadata: { examType: 'jamb' },
    });

    if (transaction.status !== 'PENDING') return transaction;

    const result = await this.vtpass.purchase({
      requestId: transaction.id,
      serviceId: 'jamb',
      customerId: buyer.phone,
      amount: dto.amount,
      phone: buyer.phone,
    });

    if (result.pin) {
      await this.emailPin(userId, 'jamb', result.pin, dto.email);
    }
    return { transactionId: transaction.id, pin: result.pin, status: result.status };
  }
}
