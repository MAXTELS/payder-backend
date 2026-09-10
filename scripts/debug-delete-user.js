// One-off diagnostic: reproduce the admin "delete user" 500 error directly
// against Prisma, bypassing Nest's exception filter (which hides the real
// error behind a generic "Internal server error"), so we can see the actual
// error code/message/meta and fix the right thing.
//
// Usage: node scripts/debug-delete-user.js <userId>
// Run from backend/ (same as reset-and-seed-admin.js).

const { PrismaClient } = require('@prisma/client');

async function main() {
  const userId = process.argv[2];
  if (!userId) {
    console.error('Usage: node scripts/debug-delete-user.js <userId>');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    console.log('User found:', user ? `${user.email} (${user.role})` : 'NOT FOUND');
    if (!user) return;

    try {
      await prisma.user.delete({ where: { id: userId } });
      console.log('DELETE SUCCEEDED (unexpected, given the reported bug)');
    } catch (err) {
      console.log('--- DELETE FAILED ---');
      console.log('name:', err.name);
      console.log('code:', err.code);
      console.log('message:', err.message);
      console.log('meta:', JSON.stringify(err.meta, null, 2));
      console.log('--- full error ---');
      console.log(err);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main();
