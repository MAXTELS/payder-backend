import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, TransactionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface PostEntryInput {
  transactionId: string;
  debitAccountId: string;
  creditAccountId: string;
  amount: Prisma.Decimal | number | string;
}

/**
 * Double-entry ledger core. Every money movement is exactly one debit and one
 * credit of equal amount, written inside the same DB transaction as the
 * Transaction row itself. A wallet's "balance" is never stored directly — it
 * is always SUM(credits) - SUM(debits) for that account, computed on read.
 * This is deliberately the least "clever" code in the codebase: correctness
 * and auditability matter far more than performance here, and if this ever
 * needs to be optimized, it should be with a materialized/cached balance
 * that is provably reconciled against the ledger, not by weakening the
 * double-entry invariant.
 */
@Injectable()
export class LedgerService {
  constructor(private prisma: PrismaService) {}

  async postEntry(tx: Prisma.TransactionClient, input: PostEntryInput) {
    if (input.debitAccountId === input.creditAccountId) {
      throw new BadRequestException('Debit and credit accounts must differ');
    }

    await tx.ledgerEntry.create({
      data: {
        transactionId: input.transactionId,
        ledgerAccountId: input.debitAccountId,
        direction: 'DEBIT',
        amount: input.amount,
      },
    });
    await tx.ledgerEntry.create({
      data: {
        transactionId: input.transactionId,
        ledgerAccountId: input.creditAccountId,
        direction: 'CREDIT',
        amount: input.amount,
      },
    });
  }

  async getBalance(ledgerAccountId: string): Promise<Prisma.Decimal> {
    const [credits, debits] = await Promise.all([
      this.prisma.ledgerEntry.aggregate({
        where: { ledgerAccountId, direction: 'CREDIT' },
        _sum: { amount: true },
      }),
      this.prisma.ledgerEntry.aggregate({
        where: { ledgerAccountId, direction: 'DEBIT' },
        _sum: { amount: true },
      }),
    ]);
    const creditTotal = credits._sum.amount ?? new Prisma.Decimal(0);
    const debitTotal = debits._sum.amount ?? new Prisma.Decimal(0);
    return creditTotal.minus(debitTotal);
  }

  /**
   * Finds (or lazily creates) a well-known system account, e.g.
   * "system:revenue", "system:suspense", "system:provider-float:paystack".
   * System accounts have no wallet attached — they exist purely as the other
   * side of a double entry for money entering/leaving the platform.
   */
  async getOrCreateSystemAccount(name: string) {
    const existing = await this.prisma.ledgerAccount.findFirst({ where: { name } });
    if (existing) return existing;
    return this.prisma.ledgerAccount.create({ data: { name } });
  }
}

export const SYSTEM_ACCOUNTS = {
  REVENUE: 'system:revenue',
  SUSPENSE: 'system:suspense',
  PROVIDER_FLOAT_PAYSTACK: 'system:provider-float:paystack',
  PROVIDER_FLOAT_FLUTTERWAVE: 'system:provider-float:flutterwave',
  // Other side of an admin-approved manual bank-transfer funding request —
  // see WalletService.creditWalletFromManualFunding.
  MANUAL_BANK_TRANSFER: 'system:provider-float:manual-bank-transfer',
} as const;

// Re-exported so callers don't need to import TransactionType from two places.
export { TransactionType };
