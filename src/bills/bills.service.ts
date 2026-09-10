import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { VtpassProvider } from './providers/vtpass.provider';
import { PurchaseDto } from './dto/purchase.dto';

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

  /**
   * Debit-then-purchase flow: the wallet debit and a PENDING Transaction
   * commit atomically first (see WalletService.debitWalletForPurchase), then
   * the provider call happens. If the provider call fails or times out, a
   * requery job (BullMQ, TODO) reconciles the outcome and reverses the debit
   * if the purchase genuinely never went through — never re-attempt the
   * provider call blindly, since VTU providers are not always idempotent on
   * their own end even when we are on ours.
   */
  async purchase(userId: string, dto: PurchaseDto, idempotencyKey: string) {
    const transaction = await this.wallet.debitWalletForPurchase({
      userId,
      amount: dto.amount,
      type: CATEGORY_TO_TRANSACTION_TYPE[dto.category],
      idempotencyKey,
    });

    if (transaction.status !== 'PENDING') {
      // Already processed (idempotent replay) — return as-is.
      return transaction;
    }

    const result = await this.vtpass.purchase({
      requestId: transaction.id,
      serviceId: dto.serviceId,
      variationCode: dto.variationCode,
      customerId: dto.customerId,
      amount: dto.amount,
      phone: dto.phone,
    });

    const status = result.status === 'success' ? 'SUCCESS' : result.status === 'pending' ? 'PROCESSING' : 'FAILED';

    const updated = await this.prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        status,
        providerReference: result.providerReference,
        completedAt: status === 'SUCCESS' ? new Date() : undefined,
        metadata: { providerMessage: result.message },
      },
    });

    if (status === 'FAILED') {
      // TODO: enqueue reversal job — credit the user back from suspense.
      this.logger.warn(`Purchase ${transaction.id} failed, reversal job needed`);
    }

    return updated;
  }

  async verifyCustomer(serviceId: string, customerId: string) {
    return this.vtpass.verifyCustomer({ serviceId, customerId });
  }
}
