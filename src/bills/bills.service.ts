import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { VtpassProvider } from './providers/vtpass.provider';
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
    private vtpass: VtpassProvider,
  ) {}

  // Proxies VTpass's service-variations lookup (data bundle plans, TV
  // bouquets) so the client never needs its own copy of VTpass's price
  // list — it always shows whatever VTpass would actually charge right now,
  // in sandbox or live, with zero PAYDER-side code change between the two.
  async listVariations(serviceId: string) {
    try {
      return await this.vtpass.getVariations(serviceId);
    } catch (err) {
      this.logger.error(`listVariations(${serviceId}) failed: ${(err as Error).message}`);
      throw new BadRequestException('Could not load plans for this service right now — try again shortly.');
    }
  }

  /**
   * Debit-then-purchase flow: the wallet debit and a PENDING Transaction
   * commit atomically first (see WalletService.debitWalletForPurchase), then
   * the provider call happens.
   *
   * For 'data' and 'tv', the amount the customer is actually charged is
   * re-derived server-side from VTpass's own service-variations lookup for
   * the chosen variationCode — never trusted from the client — the same
   * rule the Remita integration follows for its invoice amounts (see
   * ManualPaymentsService.payRemitaBill). Without this, a client could
   * request a ₦3,600 GOTV Max bouquet while claiming it costs ₦100: we'd
   * debit the customer ₦100 but VTpass would still charge PAYDER's own
   * VTpass wallet the full bouquet price.
   *
   * A 'failed' provider response reverses the debit immediately (via
   * WalletService.reversePendingDebit) rather than leaving it PENDING for a
   * background job that doesn't exist yet — same synchronous-reversal
   * pattern used by ManualPaymentsService.failRemitaBill and the withdrawal
   * orphaned-debit fix. A 'pending' response is left PROCESSING; the client
   * polls GET /bills/:id/status (checkStatus below) to resolve it, the same
   * shape as Remita's status polling.
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
      const variations = await this.listVariations(dto.serviceId);
      const match = variations.find((v) => v.code === dto.variationCode);
      if (!match) {
        throw new BadRequestException('That plan is no longer available — refresh and pick again.');
      }
      amount = match.amount;
      if (dto.category === 'tv') subscriptionType = 'change';
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
      },
    });

    if (transaction.status !== 'PENDING') {
      // Already processed (idempotent replay) — return as-is.
      return transaction;
    }

    const result = await this.vtpass.purchase({
      requestId: transaction.id,
      serviceId: dto.serviceId,
      variationCode: dto.variationCode,
      // Airtime has no billersCode in VTpass's own request shape — the
      // phone number alone identifies the recipient.
      customerId: dto.category === 'airtime' ? undefined : dto.customerId,
      amount,
      phone: dto.phone,
      subscriptionType,
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
        },
      },
    });
  }

  /**
   * Polled by the client while a purchase sits PROCESSING (VTpass responded
   * with "pending" rather than an immediate delivered/failed) — mirrors
   * ManualPaymentsService.checkRemitaStatus's re-query-the-provider-directly
   * shape. A day-one 'PENDING' transaction (never even reached VTpass)
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

    const result = await this.vtpass.requery(transaction.providerReference ?? transaction.id);

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
          },
        },
      });
    }
    return transaction; // still pending
  }

  async verifyCustomer(serviceId: string, customerId: string) {
    return this.vtpass.verifyCustomer({ serviceId, customerId });
  }
}
