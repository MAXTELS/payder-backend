import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { VtpassProvider } from './providers/vtpass.provider';
import { PairgateVtuProvider } from './providers/pairgate-vtu.provider';
import { VtuCategory } from './providers/vtu-provider.interface';
import { PurchaseDto } from './dto/purchase.dto';
import { verifyTransactionPin } from '../common/security/transaction-pin.util';

const CATEGORY_TO_TRANSACTION_TYPE = {
  airtime: 'AIRTIME',
  data: 'DATA',
  tv: 'TV_SUBSCRIPTION',
  electricity: 'ELECTRICITY',
} as const;

@Injectable()
export class BillsService {
  private readonly logger = new Logger(BillsService.name);

  constructor(
    private prisma: PrismaService,
    private wallet: WalletService,
    // 2026-09-13: swapped from VTpass to Pairgate as the live provider for
    // every category VTpass used to serve (airtime/data/tv), plus
    // electricity (never actually implemented on VTpass — see
    // vtpass.provider.ts's header comment) — per Jude's explicit request to
    // wire everything VTpass offered that Pairgate also offers, through
    // Pairgate. `vtpassLegacy` stays registered and untouched (not called
    // anywhere below) purely as a rollback path — same "kept in place
    // unused" convention already used elsewhere in this codebase — swap the
    // `provider` assignment below back to it if Pairgate ever needs to be
    // rolled back for these categories.
    private vtpassLegacy: VtpassProvider,
    private provider: PairgateVtuProvider,
  ) {}

  // Live plans/bouquets straight from Pairgate — always whatever Pairgate
  // would actually charge right now, sandbox or live, with zero PAYDER-side
  // code change between the two (same reasoning VTpass had; Pairgate's
  // `/data-plans` and `/cable-plans` replace VTpass's `/service-variations`
  // here). `category` is required now — Pairgate, unlike VTpass, has no
  // single serviceId scheme that self-disambiguates it (see
  // vtu-provider.interface.ts's header comment).
  async listVariations(serviceId: string, category: VtuCategory) {
    try {
      return await this.provider.getVariations(serviceId, category);
    } catch (err) {
      this.logger.error(`listVariations(${serviceId}, ${category}) failed: ${(err as Error).message}`);
      throw new BadRequestException('Could not load plans for this service right now — try again shortly.');
    }
  }

  // Backs a provider picker on the frontend — primarily for electricity,
  // which (unlike airtime/data/tv) has no other established serviceId list
  // in this app; see pairgate-vtu.provider.ts's header comment.
  async listProviders(category: VtuCategory) {
    return this.provider.listProviders(category);
  }

  /**
   * Debit-then-purchase flow: the wallet debit and a PENDING Transaction
   * commit atomically first (see WalletService.debitWalletForPurchase), then
   * the provider call happens.
   *
   * For 'data' and 'tv', the amount the customer is actually charged is
   * re-derived server-side from Pairgate's own plan lookup for the chosen
   * variationCode — never trusted from the client — the same "never trust
   * the client with a money figure" rule the Remita integration follows for
   * its invoice amounts (see ManualPaymentsService.payRemitaBill). Without
   * this, a client could request a ₦3,600 GOTV Max bouquet while claiming it
   * costs ₦100: we'd debit the customer ₦100 but PAYDER's own Pairgate
   * wallet would still be charged the full bouquet price.
   *
   * 'electricity' is amount-based like airtime (the customer picks how much
   * credit to buy, no price lookup exists) but additionally requires
   * `meterType` (1 = prepaid, 2 = postpaid) — Pairgate rejects the purchase
   * without it.
   *
   * A 'failed' provider response reverses the debit immediately (via
   * WalletService.reversePendingDebit) rather than leaving it PENDING for a
   * background job that doesn't exist yet — same synchronous-reversal
   * pattern used by ManualPaymentsService.failRemitaBill and the withdrawal
   * orphaned-debit fix. A 'pending' response is left PROCESSING; the client
   * polls GET /bills/:id/status (checkStatus below) to resolve it — for
   * electricity specifically, the purchase itself reports 'success' once
   * Pairgate confirms the debit, but the actual token is async (arrives via
   * the Pairgate webhook, or a later status poll) — see
   * pairgate-vtu.provider.ts's header comment.
   */
  async purchase(userId: string, dto: PurchaseDto, idempotencyKey: string) {
    const buyer = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { transactionPinHash: true },
    });
    if (!buyer) throw new NotFoundException('User not found');
    await verifyTransactionPin(buyer, dto.pin);

    let amount: string | number = dto.amount;
    let subscriptionType: 'change' | 'renew' | undefined;

    if (dto.category === 'data' || dto.category === 'tv') {
      if (!dto.variationCode) {
        throw new BadRequestException(`variationCode is required to buy ${dto.category}`);
      }
      const variations = await this.listVariations(dto.serviceId, dto.category);
      const match = variations.find((v) => v.code === dto.variationCode);
      if (!match) {
        throw new BadRequestException('That plan is no longer available — refresh and pick again.');
      }
      amount = match.amount;
      if (dto.category === 'tv') subscriptionType = 'change';
    }

    if (dto.category === 'electricity' && !dto.meterType) {
      throw new BadRequestException('meterType (prepaid or postpaid) is required to buy electricity');
    }

    const transaction = await this.wallet.debitWalletForPurchase({
      userId,
      amount,
      type: CATEGORY_TO_TRANSACTION_TYPE[dto.category],
      idempotencyKey,
      // Fingerprint for WalletService's same-minute duplicate guard — without
      // this, two different people's phone numbers topped up for the same
      // amount within a minute would collide. serviceId/variationCode are
      // included too so switching network/bundle counts as a different
      // purchase even at the same amount.
      metadata: {
        serviceId: dto.serviceId,
        customerId: dto.customerId,
        variationCode: dto.variationCode ?? null,
        meterType: dto.meterType ?? null,
      },
    });

    if (transaction.status !== 'PENDING') {
      // Already processed (idempotent replay) — return as-is.
      return transaction;
    }

    const result = await this.provider.purchase({
      requestId: transaction.id,
      serviceId: dto.serviceId,
      variationCode: dto.variationCode,
      // Airtime/electricity have no smartcard-style billersCode — airtime
      // is phone-only, electricity uses the meter number as customerId
      // (passed through as-is; only TV's "billersCode" naming was
      // VTpass-specific).
      customerId: dto.category === 'airtime' ? undefined : dto.customerId,
      amount,
      phone: dto.phone,
      subscriptionType,
      category: dto.category,
      meterType: dto.meterType,
    });

    if (result.status === 'failed') {
      this.logger.warn(`Purchase ${transaction.id} failed (${result.message}) — reversing debit`);
      return this.wallet.reversePendingDebit(
        transaction.id,
        result.message ?? 'VTU purchase failed',
      );
    }

    const status = result.status === 'success' ? 'SUCCESS' : 'PROCESSING';
    return this.prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        status,
        providerReference: result.providerReference,
        completedAt: status === 'SUCCESS' ? new Date() : undefined,
        metadata: {
          ...(transaction.metadata as object),
          providerMessage: result.message,
          pin: result.pin ?? null,
          token: result.token ?? null,
        },
      },
    });
  }

  /**
   * Polled by the client while a purchase sits PROCESSING, or while an
   * electricity/education-style purchase is SUCCESS but still waiting on an
   * async token from the Pairgate webhook — mirrors
   * ManualPaymentsService.checkRemitaStatus's re-query-the-provider-directly
   * shape. A day-one 'PENDING' transaction (never even reached Pairgate)
   * can't be requeried — there's no providerReference yet — so this only
   * acts on PROCESSING.
   */
  async checkStatus(userId: string, transactionId: string) {
    const transaction = await this.prisma.transaction.findFirst({
      where: { id: transactionId, userId },
    });
    if (!transaction) {
      throw new NotFoundException('Transaction not found');
    }
    if (transaction.status !== 'PROCESSING') {
      return transaction;
    }

    const result = await this.provider.requery(transaction.providerReference ?? transaction.id);

    if (result.status === 'failed') {
      return this.wallet.reversePendingDebit(
        transaction.id,
        result.message ?? 'VTU purchase failed (requery)',
      );
    }
    if (result.status === 'success') {
      return this.prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'SUCCESS',
          completedAt: new Date(),
          metadata: {
            ...(transaction.metadata as object),
            providerMessage: result.message,
            pin: result.pin ?? null,
            token: result.token ?? null,
          },
        },
      });
    }
    return transaction; // still pending
  }

  async verifyCustomer(
    serviceId: string,
    customerId: string,
    category?: VtuCategory,
    meterType?: 1 | 2,
  ) {
    return this.provider.verifyCustomer({ serviceId, customerId, category, meterType });
  }

  /**
   * Called by the Pairgate webhook handler (backend/src/webhooks/
   * pairgate-webhook.service.ts) when a PROCESSING electricity purchase's
   * token finally arrives asynchronously — see pairgate-vtu.provider.ts's
   * header comment for why electricity alone among these four categories
   * needs this. No-ops (returns the transaction as-is) if it's already been
   * resolved by a status poll that got there first, or isn't PROCESSING for
   * any other reason — the webhook has no documented retry/dedup guarantee
   * from Pairgate's side, so this method itself is the dedup point.
   */
  async resolveWebhookSuccess(transactionId: string, token: string | undefined, message?: string) {
    const transaction = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!transaction || transaction.status !== 'PROCESSING') return transaction;
    return this.prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        status: 'SUCCESS',
        completedAt: new Date(),
        metadata: {
          ...(transaction.metadata as object),
          providerMessage: message,
          token: token ?? null,
        },
      },
    });
  }
}
