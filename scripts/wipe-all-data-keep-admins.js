// Wipes every customer account and every transactional/history record —
// wallets, ledger accounts/entries, transactions, KYC records, support
// tickets, manual-payment/wallet-funding requests, OTP codes, devices, and
// fraud flags — plus the entire audit log. The login credentials of every
// EXISTING ADMIN/CUSTOMER_CARE account are preserved untouched (email,
// password hash, role, name). Provider/ProductCatalog config rows are left
// alone too, same as the earlier full reset (see the project doc's
// "Database reset" section).
//
// Each preserved admin/staff account also gets a brand-new, empty Wallet +
// LedgerAccount recreated (mirrors what AuthService.register does at
// signup) so nothing breaks if an admin page happens to read their own
// wallet, and their isActive flag is forced back to true in case it was
// left deactivated by earlier testing.
//
// This refuses to run (and changes nothing) if there is no ADMIN/
// CUSTOMER_CARE account to preserve — that would leave nobody able to log
// in afterwards.
//
// Run from backend/:  node --env-file=.env scripts/wipe-all-data-keep-admins.js
'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const keptAdmins = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'CUSTOMER_CARE'] } },
    select: { id: true, email: true, role: true, firstName: true, lastName: true },
  });

  if (keptAdmins.length === 0) {
    throw new Error(
      'No ADMIN/CUSTOMER_CARE account found in the database — refusing to wipe, since that ' +
        'would leave nobody able to log in afterwards. Nothing was changed.',
    );
  }

  console.log(`Found ${keptAdmins.length} admin/staff login(s) to preserve:`);
  for (const a of keptAdmins) {
    console.log(`  - ${a.email} (${a.role}) — ${a.firstName} ${a.lastName}`);
  }
  console.log('Wiping everything else...');

  // Order matters: children before the parents they reference (no ON DELETE
  // CASCADE is configured anywhere in schema.prisma, on purpose — see that
  // file's header comment — so this has to unwind the graph by hand).
  await prisma.$transaction([
    prisma.ticketMessage.deleteMany({}),
    prisma.supportTicket.deleteMany({}),
    prisma.fraudFlag.deleteMany({}),
    prisma.auditLog.deleteMany({}),
    prisma.otpCode.deleteMany({}),
    prisma.device.deleteMany({}),
    prisma.kycRecord.deleteMany({}),
    prisma.ledgerEntry.deleteMany({}),
    prisma.manualPaymentRequest.deleteMany({}),
    prisma.walletFundingRequest.deleteMany({}),
    prisma.transaction.deleteMany({}),
    prisma.ledgerAccount.deleteMany({}),
    prisma.wallet.deleteMany({}),
    // Every non-admin/staff user — everything above that referenced them has
    // already been cleared, so this is now safe.
    prisma.user.deleteMany({ where: { role: 'CUSTOMER' } }),
  ]);

  for (const admin of keptAdmins) {
    await prisma.user.update({ where: { id: admin.id }, data: { isActive: true } });
    const wallet = await prisma.wallet.create({ data: { userId: admin.id } });
    await prisma.ledgerAccount.create({
      data: { walletId: wallet.id, name: `user:${admin.id}` },
    });
  }

  console.log('');
  console.log('Wipe complete. Every customer account and all transactional/history data is gone.');
  console.log(`Preserved login(s), each with a fresh empty wallet and isActive=true:`);
  for (const a of keptAdmins) console.log(`  - ${a.email} (${a.role})`);
}

main()
  .catch((err) => {
    console.error('Wipe FAILED — see error below. Nothing after the point of failure was applied');
    console.error('(the delete step itself is one transaction, so it is all-or-nothing; only the');
    console.error('per-admin wallet recreation loop after it could partially apply if it failed');
    console.error('partway through — re-run the script if that happens, it is safe to re-run).');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
