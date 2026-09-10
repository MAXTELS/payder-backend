/**
 * One-off operational script (not part of the app) — wipes all existing
 * users and every row that hangs off them (wallets, ledger accounts/entries,
 * transactions, manual-payment/wallet-funding requests, support tickets,
 * audit logs, fraud flags), then creates a single fresh ADMIN account.
 * System ledger accounts (system:revenue, system:suspense, etc.) and the
 * Provider/ProductCatalog config tables are untouched.
 *
 * Mirrors AuthService.register()'s transaction (User -> Wallet -> LedgerAccount,
 * connecting from the wallet side since LedgerAccount.walletId is the FK owner).
 */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

async function main() {
  console.log('Truncating users (cascades to every user-owned row)...');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE users CASCADE');

  const passwordHash = await bcrypt.hash('23102003', 12);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email: 'max@max.com',
        phone: '+2340000000000',
        firstName: 'Jude',
        lastName: 'Max',
        passwordHash,
        role: 'ADMIN',
      },
    });

    const wallet = await tx.wallet.create({ data: { userId: created.id } });
    await tx.ledgerAccount.create({
      data: { name: `user:${created.id}`, wallet: { connect: { id: wallet.id } } },
    });

    return created;
  });

  const remaining = await prisma.user.count();

  console.log('Created admin user:', {
    id: user.id,
    email: user.email,
    phone: user.phone,
    role: user.role,
  });
  console.log('Total users in DB now:', remaining);
}

main()
  .catch((e) => {
    console.error('FAILED:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
