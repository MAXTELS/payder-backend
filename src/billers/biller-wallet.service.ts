import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService, SYSTEM_ACCOUNTS } from '../wallet/ledger.service';

/**
 * Biller-side counterpart to WalletService, keyed by `billerId` instead of
 * `userId` — a joint biller's two User rows share this one wallet. Posts
 * against the exact same LedgerService/ledger_entries table as customer
 * wallets; see LedgerAccount.billerWalletId in schema.prisma for the only
 * place that distinction lives.
 *
 * `getStatement` deliberately reads ledger_entries directly (join to
 * Transaction) rather than `prisma.transaction.findMany({where:{userId}})`
 * the way WalletService.getStatement does — a biller wallet has no single
 * owning userId (a joint biller's withdrawal Transactions are attributed to
 * whichever signer triggered them), so the ledger account itself is the only
 * complete, correct source of "everything that happened to this wallet".
 */
@Injectable()
export class BillerWalletService {
  constructor(
    private prisma: PrismaService,
    private ledger: LedgerService,
  ) {}

  async getWalletForBiller(billerId: string) {
    const wallet = await this.prisma.billerWallet.findUnique({
      where: { billerId },
      include: { ledgerAccount: true },
    });
    if (!wallet || !wallet.ledgerAccount) {
      throw new NotFoundException('Wallet not found for this biller');
    }
    return wallet;
  }

  /** Lazily creates the wallet + ledger account — called once, right after
   * a biller is created (see BillersAdminService.createBiller). Idempotent:
   * returns the existing wallet if one is already there. */
  async ensureWalletForBiller(billerId: string) {
    const existing = await this.prisma.billerWallet.findUnique({ where: { billerId } });
    if (existing) return existing;

    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.billerWallet.create({ data: { billerId } });
      await tx.ledgerAccount.create({
        data: { name: `biller:${billerId}`, billerWallet: { connect: { id: wallet.id } } },
      });
      return wallet;
    });
  }

  async getBalance(billerId: string) {
    const wallet = await this.getWalletForBiller(billerId);
    const balance = await this.ledger.getBalance(wallet.ledgerAccount!.id);
    return { currency: wallet.currency, balance: balance.toFixed(2), isFrozen: wallet.isFrozen };
  }

  async getStatement(billerId: string, opts: { limit: number; cursor?: string }) {
    const wallet = await this.getWalletForBiller(billerId);

    const entries = await this.prisma.ledgerEntry.findMany({
      where: { ledgerAccountId: wallet.ledgerAccount!.id },
      orderBy: { createdAt: 'desc' },
      take: opts.limit + 1,
      ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
      include: {
        transaction: {
          select: { id: true, type: true, status: true, createdAt: true, completedAt: true },
        },
      },
    });

    const hasMore = entries.length > opts.limit;
    const page = hasMore ? entries.slice(0, opts.limit) : entries;

    return {
      items: page.map((e) => ({
        id: e.id,
        direction: e.direction,
        amount: e.amount.toFixed(2),
        transaction: e.transaction,
        createdAt: e.createdAt,
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /**
   * Debits the biller wallet for a withdrawal — mirrors
   * WalletService.debitWalletForPurchase's "debit now, hold in suspense,
   * resolve later" shape exactly, just against a BillerWallet's ledger
   * account. `initiatorUserId` is who the resulting Transaction/
   * WithdrawalRequest.userId is attributed to — see WithdrawalRequest's
   * schema comment.
   */
  async debitForWithdrawal(params: {
    billerId: string;
    initiatorUserId: string;
    amount: string | number;
    idempotencyKey: string;
    fee?: string | number;
    metadata?: Record<string, unknown>;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.transaction.findUnique({
        where: { idempotencyKey: params.idempotencyKey },
      });
      if (existing) return existing;

      const wallet = await tx.billerWallet.findUnique({
        where: { billerId: params.billerId },
        include: { ledgerAccount: true },
      });
      if (!wallet || !wallet.ledgerAccount) {
        throw new NotFoundException('Wallet not found for this biller');
      }
      if (wallet.isFrozen) {
        throw new BadRequestException('This biller wallet is frozen');
      }

      const balance = await this.ledger.getBalance(wallet.ledgerAccount.id);
      const amountDecimal = new Prisma.Decimal(params.amount);
      if (balance.lessThan(amountDecimal)) {
        throw new BadRequestException('Insufficient biller wallet balance');
      }

      const transaction = await tx.transaction.create({
        data: {
          userId: params.initiatorUserId,
          type: 'TRANSFER',
          status: 'PENDING',
          amount: params.amount,
          fee: params.fee ?? 0,
          metadata: params.metadata as Prisma.InputJsonValue | undefined,
          idempotencyKey: params.idempotencyKey,
        },
      });

      const suspenseAccount = await this.ledger.getOrCreateSystemAccount(SYSTEM_ACCOUNTS.SUSPENSE);

      await this.ledger.postEntry(tx, {
        transactionId: transaction.id,
        debitAccountId: wallet.ledgerAccount.id,
        creditAccountId: suspenseAccount.id,
        amount: params.amount,
      });

      return transaction;
    });
  }
}
