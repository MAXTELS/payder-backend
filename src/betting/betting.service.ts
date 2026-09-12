import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { PairgateProvider } from './providers/pairgate.provider';
import { FundBettingDto } from './dto/fund-betting.dto';

/**
 * Betting-account funding via Pairgate. Same debit-then-purchase shape as
 * BillsService.purchase (see that file) — the wallet debit and a PENDING
 * Transaction commit atomically first, then the Pairgate call happens, then
 * the Transaction is updated with the real outcome.
 *
 * 2026-09-12: closed the same reversal gap BillsService.purchase used to
 * have. An immediate 'failed' Pairgate response now reverses the wallet
 * debit synchronously (WalletService.reversePendingDebit) instead of just
 * logging a TODO — without this, the moment PAIRGATE_USE_SANDBOX=false and
 * a purchase fails (e.g. PAYDER's own Pairgate float runs low), the
 * customer's PAYDER wallet stays debited with nothing given back. A
 * 'pending' response is left PROCESSING; checkStatus below (mirroring
 * BillsService.checkStatus) resolves it via PairgateProvider.requery, which
 * existed but was never called before this pass.
 */
@Injectable()
export class BettingService {
  private readonly logger = new Logger(BettingService.name);

  constructor(
    private prisma: PrismaService,
    private wallet: WalletService,
    private pairgate: PairgateProvider,
  ) {}

  listProviders() {
    return this.pairgate.listProviders();
  }

  verifyCustomer(providerId: string, customerId: string) {
    if (!providerId || !customerId) {
      throw new BadRequestException('providerId and customerId are required');
    }
    return this.pairgate.verifyCustomer({ providerId, customerId });
  }

  async fund(userId: string, dto: FundBettingDto, idempotencyKey: string) {
    const transaction = await this.wallet.debitWalletForPurchase({
      userId,
      amount: dto.amount,
      type: 'BETTING',
      idempotencyKey,
      // Same reasoning as BillsService.purchase's metadata — this is what
      // lets the same-minute duplicate guard tell "funded Bet9ja account
      // X twice by mistake" apart from "funded two different betting
      // accounts for the same amount within a minute" (not a duplicate).
      metadata: { providerId: dto.providerId, customerId: dto.customerId },
    });

    if (transaction.status !== 'PENDING') {
      // Already processed (idempotent replay) — return as-is.
      return transaction;
    }

    const result = await this.pairgate.purchase({
      requestId: transaction.id,
      providerId: dto.providerId,
      customerId: dto.customerId,
      amount: dto.amount,
    });

    if (result.status === 'failed') {
      this.logger.warn(`Betting funding ${transaction.id} failed (${result.message}) — reversing debit`);
      return this.wallet.reversePendingDebit(
        transaction.id,
        result.message ?? 'Betting funding failed',
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
          providerId: dto.providerId,
          customerId: dto.customerId,
          providerMessage: result.message,
        },
      },
    });
  }

  /**
   * Polled by the client while a funding request sits PROCESSING (Pairgate
   * responded with "pending" rather than an immediate success/failure) —
   * mirrors BillsService.checkStatus's re-query-the-provider-directly shape.
   * A day-one 'PENDING' transaction (never even reached Pairgate) can't be
   * requeried — there's no providerReference yet — so this only acts on
   * PROCESSING.
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

    const result = await this.pairgate.requery(transaction.providerReference ?? transaction.id);

    if (result.status === 'failed') {
      return this.wallet.reversePendingDebit(
        transaction.id,
        result.message ?? 'Betting funding failed (requery)',
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
          },
        },
      });
    }
    return transaction; // still pending
  }
}
