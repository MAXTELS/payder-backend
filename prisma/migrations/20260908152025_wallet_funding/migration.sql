-- CreateEnum
CREATE TYPE "WalletFundingStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "wallet_funding_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "destinationAccount" TEXT NOT NULL,
    "senderAccountName" TEXT NOT NULL,
    "senderBankName" TEXT NOT NULL,
    "status" "WalletFundingStatus" NOT NULL DEFAULT 'PENDING',
    "assignedAdminId" TEXT,
    "creditedTransactionId" TEXT,
    "rejectionReason" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "wallet_funding_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_funding_requests_creditedTransactionId_key" ON "wallet_funding_requests"("creditedTransactionId");

-- CreateIndex
CREATE INDEX "wallet_funding_requests_status_idx" ON "wallet_funding_requests"("status");

-- CreateIndex
CREATE INDEX "wallet_funding_requests_userId_idx" ON "wallet_funding_requests"("userId");

-- AddForeignKey
ALTER TABLE "wallet_funding_requests" ADD CONSTRAINT "wallet_funding_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_funding_requests" ADD CONSTRAINT "wallet_funding_requests_assignedAdminId_fkey" FOREIGN KEY ("assignedAdminId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_funding_requests" ADD CONSTRAINT "wallet_funding_requests_creditedTransactionId_fkey" FOREIGN KEY ("creditedTransactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
