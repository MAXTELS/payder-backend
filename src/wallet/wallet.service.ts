import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TransactionStatus, TransactionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService, SYSTEM_ACCOUNTS } from './ledger.service';
import { verifyTransactionPin } from '../common/security/transaction-pin.util';

// PAYDER's cut on a wallet-to-wallet transfer — 0.5% of the amount SENT,
// deliberately uncapped (unlike every other percentage fee in this app —
// withdrawals/betting/Remita/billers all cap at ₦1,500 — Jude's spec for
// this one didn't mention a cap, so none is applied). Charged to the
// SENDER on top of the transfer amount; the recipient always receives
// exactly what the sender typed.
const WALLET_TRANSFER_FEE_PERCENT = 0.5;

function walletTransferFee(amount: number): number {
  const fee = (amount * WALLET_TRANSFER_FEE_PERCENT) / 100;
  return Math.round(fee * 100) / 100;
}

// Generates a random 10-digit PAYDER wallet ID — first digit 1-9 (never a
// leading zero, which would make it read like a 9-digit number with padding
// rather than a real 10-digit ID). Collisions are handled by the caller
// retrying against the DB's unique constraint, not by this function.
function generateWalletId(): string {
  let id = String(1 + Math.floor(Math.random() * 9));
  for (let i = 0; i < 9; i++) id += String(Math.floor(Math.random() * 10));
  return id;
}

// Row cap for the unpaginated CSV export (getStatementExportRows) — the
// paginated getStatement above this has no such cap since the client only
// ever asks for one page at a time, but an export builds the whole file in
// memory in one request, so it needs a ceiling. 5,000 rows comfortably
// covers any individual customer's realistic history; if that's ever not
// enough, this should become a background job that emails a download link
// rather than raising the cap on a synchronous request.
const STATEMENT_EXPORT_ROW_CAP = 5000;

export interface StatementFilters {
  type?: string;
  status?: string;
  from?: string; // ISO date (inclusive)
  to?: string; // ISO date (inclusive)
}

// How long a just-submitted purchase "blocks" an identical resubmission —
// see debitWalletForPurchase's duplicate-guard comment below. One minute
// comfortably covers an impatient double-tap or a flaky-network retry
// without getting in the way of someone who genuinely wants to buy the same
// thing twice a few minutes apart (e.g. topping up two different phones one
// after another would only collide if every field, including the recipient,
// matched too).
const DUPLICATE_PURCHASE_WINDOW_MS = 60_000;

@Injectable()
export class WalletService {
  constructor(
    private prisma: PrismaService,
    private ledger: LedgerService,
  ) {}

  async getWalletForUser(userId: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
      include: { ledgerAccount: true },
    });
    if (!wallet || !wallet.ledgerAccount) {
      throw new NotFoundException('Wallet not found for user');
    }
    return wallet;
  }

  async getBalance(userId: string) {
    const wallet = await this.getWalletForUser(userId);
    const balance = await this.ledger.getBalance(wallet.ledgerAccount!.id);
    const walletId = wallet.walletId ?? (await this.getOrCreateWalletId(userId));
    return {
      currency: wallet.currency,
      balance: balance.toFixed(2),
      walletId,
      virtualAccountNumber: wallet.virtualAccountNumber,
      virtualAccountBank: wallet.virtualAccountBank,
      virtualAccountProvider: wallet.virtualAccountProvider,
    };
  }

  /**
   * Returns this user's 10-digit PAYDER wallet ID, generating and persisting
   * one on first call if it doesn't exist yet (see Wallet.walletId's schema
   * comment for why this is lazy rather than a migration backfill). Retries
   * on a random collision against the unique constraint — astronomically
   * unlikely at any realistic user count (1 in ~900 million per attempt)
   * but handled properly rather than assumed away.
   */
  async getOrCreateWalletId(userId: string): Promise<string> {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('Wallet not found for user');
    if (wallet.walletId) return wallet.walletId;

    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = generateWalletId();
      try {
        const updated = await this.prisma.wallet.update({
          where: { userId },
          data: { walletId: candidate },
        });
        return updated.walletId!;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          continue; // collision — try another candidate
        }
        throw err;
      }
    }
    throw new Error('Could not generate a unique wallet ID — please try again');
  }

  /**
   * Step 1 of a wallet-to-wallet transfer: look up who a wallet ID belongs
   * to and show a confirmation preview BEFORE any money moves — same
   * "verify, then pay" pattern used everywhere else in this app (TV
   * smartcard, betting account, electricity meter). Returns only a masked
   * name (first name + last-initial) — a customer's full name is not
   * something a stranger who guessed/mistyped a wallet ID should see.
   */
  async lookupWalletId(walletId: string, requestingUserId: string) {
    if (!/^\d{10}$/.test(walletId)) {
      throw new BadRequestException('Wallet ID must be exactly 10 digits');
    }
    const wallet = await this.prisma.wallet.findUnique({
      where: { walletId },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
    });
    if (!wallet) {
      throw new NotFoundException('No PAYDER wallet found with that ID');
    }
    if (wallet.userId === requestingUserId) {
      throw new BadRequestException('That is your own wallet ID');
    }
    if (wallet.isFrozen) {
      throw new BadRequestException('That wallet cannot receive transfers right now');
    }
    const lastInitial = wallet.user.lastName?.trim().charAt(0) ?? '';
    return {
      walletId,
      name: `${wallet.user.firstName}${lastInitial ? ` ${lastInitial}.` : ''}`,
    };
  }

  /**
   * Step 2: the actual transfer. Instant and internal — unlike every other
   * purchase in this app there's no external provider to call, so this
   * resolves SUCCESS synchronously inside one DB transaction rather than
   * going through the debit-then-purchase-then-reconcile shape.
   *
   * Produces TWO Transaction rows (sender + recipient) rather than the
   * usual one, so the transfer shows correctly in BOTH parties' own
   * transaction history (which is always queried by `userId` — see
   * getStatement). The real double-entry ledger postings (which is what
   * actually moves the money and is what getBalance/reconciliation rely on)
   * are posted entirely under the SENDER's transaction id: debit sender for
   * the transfer amount / credit recipient's ledger account, then debit
   * sender again for the fee / credit system:revenue — both pairs balance,
   * so that transaction's own entries reconcile to zero on their own. The
   * recipient's Transaction row is deliberately a display-only record with
   * no LedgerEntry rows of its own (their balance already reflects the
   * credit via the sender-side entries above) — a Transaction having zero
   * ledger entries is unusual elsewhere in this codebase but not invalid;
   * it exists purely so `WalletService.getStatement` (which filters by
   * `userId`) shows the incoming transfer in the recipient's own history.
   */
  async transferToWallet(
    senderId: string,
    params: { toWalletId: string; amount: number; pin: string },
    idempotencyKey: string,
  ) {
    if (!params.amount || params.amount <= 0) {
      throw new BadRequestException('Enter a valid amount');
    }

    const sender = await this.prisma.user.findUnique({
      where: { id: senderId },
      select: { transactionPinHash: true, firstName: true, lastName: true },
    });
    if (!sender) throw new NotFoundException('User not found');
    await verifyTransactionPin(sender, params.pin);

    const fee = walletTransferFee(params.amount);
    const totalDebit = params.amount + fee;

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.transaction.findUnique({ where: { idempotencyKey } });
      if (existing) return existing;

      const senderWallet = await tx.wallet.findUnique({
        where: { userId: senderId },
        include: { ledgerAccount: true },
      });
      if (!senderWallet?.ledgerAccount) throw new NotFoundException('Wallet not found');
      if (senderWallet.isFrozen) throw new BadRequestException('Your wallet is frozen');

      const recipientWallet = await tx.wallet.findUnique({
        where: { walletId: params.toWalletId },
        include: {
          ledgerAccount: true,
          user: { select: { id: true, firstName: true, lastName: true } },
        },
      });
      if (!recipientWallet?.ledgerAccount) {
        throw new NotFoundException('No PAYDER wallet found with that ID');
      }
      if (recipientWallet.userId === senderId) {
        throw new BadRequestException('You cannot transfer to your own wallet');
      }
      if (recipientWallet.isFrozen) {
        throw new BadRequestException('That wallet cannot receive transfers right now');
      }

      const balance = await this.ledger.getBalance(senderWallet.ledgerAccount.id);
      if (balance.lessThan(new Prisma.Decimal(totalDebit))) {
        throw new BadRequestException('Insufficient wallet balance');
      }

      const senderName = `${sender.firstName} ${sender.lastName}`;
      const recipientName = `${recipientWallet.user.firstName} ${recipientWallet.user.lastName}`;

      const senderTransaction = await tx.transaction.create({
        data: {
          userId: senderId,
          type: 'WALLET_TRANSFER',
          status: 'SUCCESS',
          amount: totalDebit,
          fee,
          idempotencyKey,
          completedAt: new Date(),
          metadata: {
            direction: 'sent',
            toWalletId: params.toWalletId,
            toUserId: recipientWallet.userId,
            recipientName,
            transferAmount: params.amount,
            fee,
          },
        },
      });

      // Real ledger postings — both pairs balance under this one
      // transaction id (see this method's header comment).
      await this.ledger.postEntry(tx, {
        transactionId: senderTransaction.id,
        debitAccountId: senderWallet.ledgerAccount.id,
        creditAccountId: recipientWallet.ledgerAccount.id,
        amount: params.amount,
      });
      if (fee > 0) {
        const revenueAccount = await this.ledger.getOrCreateSystemAccount(SYSTEM_ACCOUNTS.REVENUE);
        await this.ledger.postEntry(tx, {
          transactionId: senderTransaction.id,
          debitAccountId: senderWallet.ledgerAccount.id,
          creditAccountId: revenueAccount.id,
          amount: fee,
        });
      }

      // Display-only counterpart so the recipient sees this in their own
      // history too — see this method's header comment for why it
      // deliberately carries no ledger entries of its own.
      await tx.transaction.create({
        data: {
          userId: recipientWallet.userId,
          type: 'WALLET_TRANSFER',
          status: 'SUCCESS',
          amount: params.amount,
          fee: 0,
          idempotencyKey: `${idempotencyKey}:credit`,
          completedAt: new Date(),
          metadata: {
            direction: 'received',
            fromWalletId: senderWallet.walletId ?? undefined,
            fromUserId: senderId,
            senderName,
            transferAmount: params.amount,
          },
        },
      });

      return senderTransaction;
    });
  }

  /**
   * Paginated recent-activity feed for the dashboard/wallet screens AND the
   * dedicated Transaction History page — same endpoint, the history page
   * just also passes the optional type/status/from/to filters. Cursor-based
   * (createdAt+id) rather than offset-based so pages stay stable as new
   * transactions land ahead of an in-progress scroll.
   */
  async getStatement(
    userId: string,
    opts: { limit: number; cursor?: string } & StatementFilters,
  ) {
    const where = this.buildStatementWhere(userId, opts);
    const items = await this.prisma.transaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: opts.limit + 1,
      ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
      select: {
        id: true,
        type: true,
        status: true,
        amount: true,
        fee: true,
        providerReference: true,
        metadata: true,
        createdAt: true,
        completedAt: true,
      },
    });

    const hasMore = items.length > opts.limit;
    const page = hasMore ? items.slice(0, opts.limit) : items;

    return {
      items: page.map((t) => ({ ...t, amount: t.amount.toFixed(2), fee: t.fee.toFixed(2) })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /**
   * Unpaginated rows for the Transaction History page's CSV export — same
   * filters as getStatement, capped at STATEMENT_EXPORT_ROW_CAP rather than
   * walking cursor pages, since this is one synchronous request that builds
   * the whole file in memory. See WalletController.exportStatement.
   */
  async getStatementExportRows(userId: string, filters: StatementFilters) {
    const where = this.buildStatementWhere(userId, filters);
    return this.prisma.transaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: STATEMENT_EXPORT_ROW_CAP,
      select: {
        id: true,
        type: true,
        status: true,
        amount: true,
        fee: true,
        providerReference: true,
        metadata: true,
        createdAt: true,
        completedAt: true,
      },
    });
  }

  /** Small helper purely for the PDF statement export's header line — see
   * WalletController.exportStatement. */
  async getStatementCustomerName(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true, email: true },
    });
    if (!user) return '';
    return `${user.firstName} ${user.lastName} (${user.email})`;
  }

  private buildStatementWhere(
    userId: string,
    filters: StatementFilters,
  ): Prisma.TransactionWhereInput {
    const where: Prisma.TransactionWhereInput = { userId };

    if (filters.type) {
      if (!(Object.values(TransactionType) as string[]).includes(filters.type)) {
        throw new BadRequestException(`Unknown transaction type: ${filters.type}`);
      }
      where.type = filters.type as TransactionType;
    }

    if (filters.status) {
      if (!(Object.values(TransactionStatus) as string[]).includes(filters.status)) {
        throw new BadRequestException(`Unknown transaction status: ${filters.status}`);
      }
      where.status = filters.status as TransactionStatus;
    }

    if (filters.from || filters.to) {
      const from = filters.from ? new Date(filters.from) : undefined;
      const to = filters.to ? new Date(filters.to) : undefined;
      if ((from && isNaN(from.getTime())) || (to && isNaN(to.getTime()))) {
        throw new BadRequestException('from/to must be valid dates');
      }
      where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    }

    return where;
  }

  /**
   * Credits a user's wallet after a confirmed inbound payment (Paystack/
   * Flutterwave webhook, already verified — see PaymentsService). Wrapped in
   * a single DB transaction: the Transaction row, both ledger entries, and
   * the idempotency check all commit together or not at all.
   */
  async creditWalletFromFunding(params: {
    userId: string;
    amount: string | number;
    provider: 'paystack' | 'flutterwave';
    providerReference: string;
    idempotencyKey: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.transaction.findUnique({
        where: { idempotencyKey: params.idempotencyKey },
      });
      if (existing) return existing; // already processed — webhook retried

      const wallet = await tx.wallet.findUnique({
        where: { userId: params.userId },
        include: { ledgerAccount: true },
      });
      if (!wallet || !wallet.ledgerAccount) {
        throw new NotFoundException('Wallet not found for user');
      }
      if (wallet.isFrozen) {
        throw new BadRequestException('Wallet is frozen');
      }

      const providerRow = await tx.provider.findUnique({
        where: { name: params.provider },
      });

      const transaction = await tx.transaction.create({
        data: {
          userId: params.userId,
          type: 'WALLET_FUNDING',
          status: 'SUCCESS',
          amount: params.amount,
          providerId: providerRow?.id,
          providerReference: params.providerReference,
          idempotencyKey: params.idempotencyKey,
          completedAt: new Date(),
        },
      });

      const floatAccountName =
        params.provider === 'paystack'
          ? SYSTEM_ACCOUNTS.PROVIDER_FLOAT_PAYSTACK
          : SYSTEM_ACCOUNTS.PROVIDER_FLOAT_FLUTTERWAVE;
      const floatAccount = await this.ledger.getOrCreateSystemAccount(floatAccountName);

      // Money "enters" from the provider float account into the user's
      // ledger account: debit the float, credit the user.
      await this.ledger.postEntry(tx, {
        transactionId: transaction.id,
        debitAccountId: floatAccount.id,
        creditAccountId: wallet.ledgerAccount.id,
        amount: params.amount,
      });

      return transaction;
    });
  }

  /**
   * Credits a user's wallet after an admin has verified a manual bank-transfer
   * funding claim (WalletFundingRequest). Mirrors creditWalletFromFunding
   * (used for Paystack/Flutterwave webhooks) but the "provider" side is the
   * MANUAL_BANK_TRANSFER system float account, and there is no webhook
   * signature to verify — the admin's approval IS the verification. Wrapped
   * in the same DB transaction as the WalletFundingRequest update by the
   * caller (WalletFundingService.approve), so pass the transaction client in.
   */
  async creditWalletFromManualFunding(
    tx: Prisma.TransactionClient,
    params: { userId: string; amount: string | number; idempotencyKey: string },
  ) {
    const existing = await tx.transaction.findUnique({
      where: { idempotencyKey: params.idempotencyKey },
    });
    if (existing) return existing;

    const wallet = await tx.wallet.findUnique({
      where: { userId: params.userId },
      include: { ledgerAccount: true },
    });
    if (!wallet || !wallet.ledgerAccount) {
      throw new NotFoundException('Wallet not found for user');
    }
    if (wallet.isFrozen) {
      throw new BadRequestException('Wallet is frozen');
    }

    const transaction = await tx.transaction.create({
      data: {
        userId: params.userId,
        type: 'WALLET_FUNDING',
        status: 'SUCCESS',
        amount: params.amount,
        idempotencyKey: params.idempotencyKey,
        completedAt: new Date(),
      },
    });

    const floatAccount = await this.ledger.getOrCreateSystemAccount(
      SYSTEM_ACCOUNTS.MANUAL_BANK_TRANSFER,
    );

    await this.ledger.postEntry(tx, {
      transactionId: transaction.id,
      debitAccountId: floatAccount.id,
      creditAccountId: wallet.ledgerAccount.id,
      amount: params.amount,
    });

    return transaction;
  }

  /**
   * Debits a user's wallet to pay for a product (airtime/data/bill/exam pin).
   * Called by BillsService/ExamsService BEFORE calling out to the external
   * provider, inside the same DB transaction as marking the Transaction
   * PENDING — if the provider call then fails, ReversalService (TODO) credits
   * the user back rather than this debit being left dangling.
   */
  async debitWalletForPurchase(params: {
    userId: string;
    amount: string | number;
    type:
      | 'AIRTIME'
      | 'DATA'
      | 'TV_SUBSCRIPTION'
      | 'ELECTRICITY'
      | 'EXAM_PIN'
      | 'BILL_PAYMENT'
      // Betting-account funding via Pairgate — see betting module.
      | 'BETTING'
      // Customer -> Biller bill payment (see biller-feature-spec.md, phase 2)
      // — same "debit now, hold in suspense" shape as every other purchase
      // type here; the only difference is what happens on settlement (a
      // 3-way split between the biller's wallet and system:revenue, done by
      // whichever service completes the BillerPayment, not here).
      | 'BILLER_BILL_PAYMENT'
      // Withdrawals reuse this same debit-then-hold flow (see
      // WithdrawalsService.create) rather than a dedicated wallet method —
      // the money leaves the ledger into suspense the same way a purchase
      // does, resolved later by an admin marking it PAID or REJECTED.
      | 'TRANSFER';
    idempotencyKey: string;
    // Optional reporting-only breakdown — shown on the customer's statement
    // (see listStatement's fee mapping) but never affects the ledger math:
    // the full `amount` is always what actually leaves the wallet, whether
    // or not any of it is "fee". `metadata` is a free-form record of how the
    // total was made up (e.g. Remita's own fee + PAYDER's portal fee), kept
    // for support/audit purposes.
    fee?: string | number;
    metadata?: Record<string, unknown>;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.transaction.findUnique({
        where: { idempotencyKey: params.idempotencyKey },
      });
      if (existing) return existing;

      // Same-minute duplicate guard: a client-generated idempotency key only
      // catches a *retried* request (the client sending the exact same key
      // again, e.g. after a timeout). It does nothing for two genuinely
      // separate submissions with identical details — a double-tap on "Buy"
      // that the UI didn't debounce, or someone hitting submit twice because
      // nothing seemed to happen the first time. This catches that case:
      // same user, same type, same amount, same metadata (when provided —
      // e.g. the same recipient phone/meter number), within the last minute.
      // Metadata is compared as a normalized JSON string; two purchases that
      // differ only in *who* they're for (different phone/meter/customerId)
      // are legitimately different and must NOT be blocked, which is exactly
      // why this isn't just userId+type+amount.
      const recentWindowStart = new Date(Date.now() - DUPLICATE_PURCHASE_WINDOW_MS);
      const recentCandidates = await tx.transaction.findMany({
        where: {
          userId: params.userId,
          type: params.type,
          amount: new Prisma.Decimal(params.amount),
          status: { in: ['PENDING', 'PROCESSING', 'SUCCESS'] },
          createdAt: { gte: recentWindowStart },
        },
        select: { metadata: true },
      });
      if (recentCandidates.length > 0) {
        const fingerprint = JSON.stringify(params.metadata ?? null);
        const isDuplicate = recentCandidates.some(
          (t) => JSON.stringify(t.metadata ?? null) === fingerprint,
        );
        if (isDuplicate) {
          throw new ConflictException(
            'An identical transaction was just submitted — please wait a minute before retrying.',
          );
        }
      }

      const wallet = await tx.wallet.findUnique({
        where: { userId: params.userId },
        include: { ledgerAccount: true },
      });
      if (!wallet || !wallet.ledgerAccount) {
        throw new NotFoundException('Wallet not found for user');
      }
      if (wallet.isFrozen) {
        throw new BadRequestException('Wallet is frozen');
      }

      const balance = await this.ledger.getBalance(wallet.ledgerAccount.id);
      const amountDecimal = new Prisma.Decimal(params.amount);
      if (balance.lessThan(amountDecimal)) {
        throw new BadRequestException('Insufficient wallet balance');
      }

      const transaction = await tx.transaction.create({
        data: {
          userId: params.userId,
          type: params.type,
          status: 'PENDING', // becomes SUCCESS/FAILED once the provider responds
          amount: params.amount,
          fee: params.fee ?? 0,
          metadata: params.metadata as Prisma.InputJsonValue | undefined,
          idempotencyKey: params.idempotencyKey,
        },
      });

      const suspenseAccount = await this.ledger.getOrCreateSystemAccount(
        SYSTEM_ACCOUNTS.SUSPENSE,
      );

      // Debit the user, credit suspense — money is "in flight" to the
      // external provider until the purchase is confirmed or reversed.
      await this.ledger.postEntry(tx, {
        transactionId: transaction.id,
        debitAccountId: wallet.ledgerAccount.id,
        creditAccountId: suspenseAccount.id,
        amount: params.amount,
      });

      return transaction;
    });
  }

  /**
   * Reverses a PENDING purchase debit that never completed — credits
   * whoever was originally debited back from suspense and marks the
   * Transaction REVERSED. Used today by the manual invoice-payment flow
   * (§5.4b) and by withdrawal rejection (customer AND biller — see
   * WithdrawalsService.reject) when an admin rejects a request; the same
   * method is what a future BullMQ requery job should call when a VTU/bill
   * purchase comes back FAILED after the debit already happened, so there's
   * only one reversal code path to trust.
   *
   * Deliberately does NOT re-derive "whose wallet do I credit back" from
   * `transaction.userId` (a customer's personal Wallet) — that assumption
   * broke the moment a second kind of ledger owner (BillerWallet) existed,
   * since a biller withdrawal's Transaction.userId is just whichever
   * biller-user triggered it, not the account the money actually left.
   * Instead this reads the transaction's own DEBIT ledger entry and credits
   * *that* ledger account back — correct for a customer wallet or a biller
   * wallet with zero branching, and byte-for-byte the same behavior as
   * before for every existing customer-withdrawal-reject call site (the
   * debit entry's ledgerAccountId was always the customer's own wallet
   * anyway).
   */
  async reversePendingDebit(transactionId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.findUnique({
        where: { id: transactionId },
        include: { ledgerEntries: true },
      });
      if (!transaction) {
        throw new NotFoundException('Transaction not found');
      }
      if (transaction.status !== 'PENDING' && transaction.status !== 'PROCESSING') {
        // Already resolved one way or another — reversal only makes sense
        // for a debit still sitting in suspense.
        throw new BadRequestException(
          `Cannot reverse a transaction in status ${transaction.status}`,
        );
      }

      const debitEntry = transaction.ledgerEntries.find((e) => e.direction === 'DEBIT');
      if (!debitEntry) {
        throw new BadRequestException('Transaction has no debit entry to reverse');
      }

      const suspenseAccount = await this.ledger.getOrCreateSystemAccount(
        SYSTEM_ACCOUNTS.SUSPENSE,
      );

      // Original debit-then-purchase flow debited the owning ledger account
      // and credited suspense. Reversing it is the mirror image: debit
      // suspense, credit that same ledger account back.
      await this.ledger.postEntry(tx, {
        transactionId: transaction.id,
        debitAccountId: suspenseAccount.id,
        creditAccountId: debitEntry.ledgerAccountId,
        amount: transaction.amount,
      });

      return tx.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'REVERSED',
          completedAt: new Date(),
          metadata: { ...(transaction.metadata as object), reversalReason: reason },
        },
      });
    });
  }
}
