// One-off repair script.
//
// Reverses withdrawal-request debits that succeeded (money left the
// customer's wallet into suspense) but whose matching WithdrawalRequest row
// never got created. This happened for withdrawal attempts made before the
// withdrawal_requests migration was applied / the Prisma Client was
// regenerated (and the backend restarted): WithdrawalsService.create()
// calls WalletService.debitWalletForPurchase() (which commits its own DB
// transaction immediately) and only THEN calls
// prisma.withdrawalRequest.create() — if that second call throws because
// the model doesn't exist yet in the currently-loaded Prisma Client, the
// debit has already committed, so the customer loses the amount+fee with no
// request record anywhere and the API call still errors out.
//
// This script finds every such orphaned debit and reverses it (credits the
// customer back, marks the Transaction REVERSED) — the same operation
// WalletService.reversePendingDebit() performs, reimplemented directly
// against Prisma here since this runs standalone, outside the Nest app.
//
// Run with:  node --env-file=.env scripts/fix-orphaned-withdrawal-debits.js
// (from the backend/ folder) — or just double-click run-fix-withdrawals.bat
// at the PAYDER root, which runs the migration + Prisma generate + this
// script together, in the right order.

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const SUSPENSE_ACCOUNT_NAME = 'system:suspense';

async function main() {
  const candidates = await prisma.transaction.findMany({
    where: {
      type: 'TRANSFER',
      status: { in: ['PENDING', 'PROCESSING'] },
    },
  });

  // Only ones that actually look like a withdrawal debit (the metadata
  // shape WithdrawalsService.create() writes) — a future, unrelated use of
  // the TRANSFER type shouldn't get swept up by this one-off script.
  const withdrawalLike = candidates.filter(
    (t) => t.metadata && typeof t.metadata === 'object' && 'withdrawalAmount' in t.metadata,
  );

  if (withdrawalLike.length === 0) {
    console.log('No withdrawal-shaped pending debits found. Nothing to do.');
    return;
  }

  // If the withdrawal_requests table exists now (migration applied), skip
  // any transaction that already has a matching WithdrawalRequest row —
  // those are real, successfully-created requests, not orphans.
  let existingRequestTxIds = new Set();
  try {
    const requests = await prisma.withdrawalRequest.findMany({
      select: { heldTransactionId: true },
    });
    existingRequestTxIds = new Set(requests.map((r) => r.heldTransactionId));
  } catch (err) {
    console.log(
      'Could not query withdrawal_requests (migration may not be applied yet) — treating every TRANSFER-type pending debit with withdrawal metadata as an orphan.',
    );
  }

  const orphans = withdrawalLike.filter((t) => !existingRequestTxIds.has(t.id));

  if (orphans.length === 0) {
    console.log(
      `Found ${withdrawalLike.length} withdrawal-shaped debit(s), but all of them already have a matching request. Nothing to do.`,
    );
    return;
  }

  console.log(`Found ${orphans.length} orphaned withdrawal debit(s). Reversing...`);

  for (const t of orphans) {
    await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({
        where: { userId: t.userId },
        include: { ledgerAccount: true },
      });
      if (!wallet || !wallet.ledgerAccount) {
        console.log(`  Skipping transaction ${t.id} — no wallet found for user ${t.userId}.`);
        return;
      }

      let suspense = await tx.ledgerAccount.findFirst({ where: { name: SUSPENSE_ACCOUNT_NAME } });
      if (!suspense) {
        suspense = await tx.ledgerAccount.create({ data: { name: SUSPENSE_ACCOUNT_NAME } });
      }

      // Mirrors WalletService.reversePendingDebit: original debit-then-hold
      // was "debit user, credit suspense" — reversing it is the mirror
      // image, "debit suspense, credit user back".
      await tx.ledgerEntry.create({
        data: { transactionId: t.id, ledgerAccountId: suspense.id, direction: 'DEBIT', amount: t.amount },
      });
      await tx.ledgerEntry.create({
        data: {
          transactionId: t.id,
          ledgerAccountId: wallet.ledgerAccount.id,
          direction: 'CREDIT',
          amount: t.amount,
        },
      });

      await tx.transaction.update({
        where: { id: t.id },
        data: {
          status: 'REVERSED',
          completedAt: new Date(),
          metadata: {
            ...(t.metadata && typeof t.metadata === 'object' ? t.metadata : {}),
            reversalReason:
              'Orphaned withdrawal debit — WithdrawalRequest row was never created (Prisma Client not yet regenerated at the time). Reversed by fix-orphaned-withdrawal-debits.js.',
          },
        },
      });

      console.log(`  Reversed transaction ${t.id} — credited NGN ${t.amount} back to user ${t.userId}.`);
    });
  }

  console.log('Done.');
}

main()
  .catch((err) => {
    console.error('Script failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
