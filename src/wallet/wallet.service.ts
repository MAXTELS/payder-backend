import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService, SYSTEM_ACCOUNTS } from './ledger.service';

// How long a just-submitted purchase "blocks" an identical resubmission —
// see debitWalletForPurchase's duplicate-guard comment below. One minute
// comfortably covers an impatient double-tap or a flaky-network retry
// without getting in the way of someone who genuinely wants to buy the same
// thing twice a few minutes apart (e.g. topping up two different phones one
// after another would only collide if every field, including the recipient,
// matched too).
const DUPLICATE_PURCHASE_WINDOW_MS = 60_000;

// KYC-tier hard limits for unapproved (Tier 0) accounts — requested
// 2026-09-12 for "regular customer" accounts that haven't been KYC-approved
// yet. TIER_0 is every user's default tier (see schema.prisma's
// `kycTier @default(TIER_0)`) until an admin approves a KycRecord that
// bumps them to TIER_1+, so "unapproved" here means exactly `kycTier ===
// 'TIER_0'` — no separate flag needed. Both limits lift automatically the
// moment that happens; nothing here needs updating when it does. See
// assertWithinTier0Limits below for how they're enforced.
const TIER_0_MAX_BALANCE = new Prisma.Decimal(20000);
const TIER_0_MAX_LIFETIME_VOLUME = new Prisma.Decimal(50000);

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
    return {
      currency: wallet.currency,
      balance: balance.toFixed(2),
      virtualAccountNumber: wallet.virtualAccountNumber,
      virtualAccountBank: wallet.virtualAccountBank,
      virtualAccountProvider: wallet.virtualAccountProvider,
    };
  }

  /**
   * Paginated recent-activity feed for the dashboard/wallet screens.
   * Cursor-based (createdAt+id) rather than offset-based so pages stay
   * stable as new transactions land ahead of an in-progress scroll.
   */
  async getStatement(userId: string, opts: { limit: number; cursor?: string }) {
    const items = await this.prisma.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: opts.limit + 1,
      ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
      select: {
        id: true,
        type: true,
        status: true,
        amount: true,
        fee: true,
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
   * Enforces the Tier-0 (KYC-unapproved) hard limits declared above:
   *  - a ₦20,000 maximum wallet balance — checked only for a CREDIT, since a
   *    debit can only ever lower the balance, never push it over the cap;
   *  - a ₦50,000 lifetime cap on total transaction volume — every debit and
   *    credit this user has ever had, summed, checked for both kinds. "Lifetime"
   *    is deliberate (not daily): the user asked that *all* transaction history
   *    stay under ₦50,000 for an unapproved account, not a rolling window.
   *
   * Only counts transactions whose money actually moved or is currently in
   * flight (`SUCCESS`, `PENDING`, `PROCESSING`) — a `REVERSED` transaction's
   * amount was given back, so it's deliberately excluded from the running
   * total (otherwise a reversed purchase would permanently eat into a Tier 0
   * user's lifetime allowance for money they got back).
   *
   * Called from inside the same `$transaction` as the write it's guarding
   * (via the passed-in `tx`), so the check and the debit/credit it gates
   * commit atomically together. `getBalance` below still reads through the
   * default `this.ledger`/`this.prisma` client rather than `tx` — the same
   * pre-existing pattern every other balance read in this file already uses,
   * not a new inconsistency introduced here.
   *
   * Deliberately NOT called from reversePendingDebit — a reversal returns
   * money that already counted against the cap when it was first debited;
   * gating the refund itself would trap a Tier 0 customer's own money.
   */
  private async assertWithinTier0Limits(
    tx: Prisma.TransactionClient,
    params: {
      userId: string;
      amount: string | number;
      kind: 'credit' | 'debit';
      ledgerAccountId: string;
    },
  ) {
    const user = await tx.user.findUnique({
      where: { id: params.userId },
      select: { kycTier: true },
    });
    if (!user || user.kycTier !== 'TIER_0') return; // limits only bind unapproved accounts

    const amountDecimal = new Prisma.Decimal(params.amount);

    if (params.kind === 'credit') {
      const currentBalance = await this.ledger.getBalance(params.ledgerAccountId);
      if (currentBalance.plus(amountDecimal).greaterThan(TIER_0_MAX_BALANCE)) {
        throw new BadRequestException(
          `Unverified accounts can hold a maximum wallet balance of ₦${TIER_0_MAX_BALANCE.toFixed(2)}. Complete KYC verification to raise this limit.`,
        );
      }
    }

    const volume = await tx.transaction.aggregate({
      where: {
        userId: params.userId,
        status: { in: ['SUCCESS', 'PENDING', 'PROCESSING'] },
      },
      _sum: { amount: true },
    });
    const existingVolume = volume._sum.amount ?? new Prisma.Decimal(0);
    if (existingVolume.plus(amountDecimal).greaterThan(TIER_0_MAX_LIFETIME_VOLUME)) {
      throw new BadRequestException(
        `Unverified accounts are limited to ₦${TIER_0_MAX_LIFETIME_VOLUME.toFixed(2)} in total transactions (funding and spending combined). Complete KYC verification to continue.`,
      );
    }
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

      await this.assertWithinTier0Limits(tx, {
        userId: params.userId,
        amount: params.amount,
        kind: 'credit',
        ledgerAccountId: wallet.ledgerAccount.id,
      });

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

    await this.assertWithinTier0Limits(tx, {
      userId: params.userId,
      amount: params.amount,
      kind: 'credit',
      ledgerAccountId: wallet.ledgerAccount.id,
    });

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

      await this.assertWithinTier0Limits(tx, {
        userId: params.userId,
        amount: params.amount,
        kind: 'debit',
        ledgerAccountId: wallet.ledgerAccount.id,
      });

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
   *
   * Deliberately does NOT run assertWithinTier0Limits — this returns money
   * that already counted against a Tier 0 user's lifetime cap when it was
   * first debited; gating the refund itself would trap their own money
   * rather than protect anything.
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
