-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'WALLET_TRANSFER';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "activeMobileDeviceId" TEXT,
ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "wallets" ADD COLUMN     "walletId" TEXT;
CREATE UNIQUE INDEX "wallets_walletId_key" ON "wallets"("walletId");

-- CreateTable
CREATE TABLE "admin_notification_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "emails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_notification_settings_pkey" PRIMARY KEY ("id")
);
