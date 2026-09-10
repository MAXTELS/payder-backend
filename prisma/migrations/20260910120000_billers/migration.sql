-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'BILLER';

-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'BILLER_BILL_PAYMENT';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "billerId" TEXT,
ADD COLUMN     "billerLabel" TEXT,
ADD COLUMN     "ninEncrypted" TEXT;

-- AlterTable
ALTER TABLE "ledger_accounts" ADD COLUMN     "billerWalletId" TEXT;

-- AlterTable
ALTER TABLE "withdrawal_requests" ADD COLUMN     "billerId" TEXT;

-- CreateTable
CREATE TABLE "billers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "isJoint" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biller_wallets" (
    "id" TEXT NOT NULL,
    "billerId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "isFrozen" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "biller_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_definitions" (
    "id" TEXT NOT NULL,
    "billerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "pricingMode" TEXT NOT NULL,
    "flatAmount" DECIMAL(18,2),
    "pricingTable" JSONB,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "oneTimeEditUnlockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bill_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biller_withdrawal_drafts" (
    "id" TEXT NOT NULL,
    "billerId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "initiatedByUserId" TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'AWAITING_APPROVAL',
    "resultingWithdrawalRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "biller_withdrawal_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biller_report_preferences" (
    "id" TEXT NOT NULL,
    "billerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'DAILY',
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "biller_report_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biller_payments" (
    "id" TEXT NOT NULL,
    "billerId" TEXT NOT NULL,
    "billDefinitionId" TEXT NOT NULL,
    "userId" TEXT,
    "guestName" TEXT,
    "guestEmail" TEXT,
    "guestPhone" TEXT,
    "fieldValues" JSONB NOT NULL,
    "billAmount" DECIMAL(18,2) NOT NULL,
    "portalFee" DECIMAL(18,2) NOT NULL,
    "totalAmount" DECIMAL(18,2) NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "transactionId" TEXT,
    "paystackReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "biller_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "users_billerId_idx" ON "users"("billerId");

-- CreateIndex
CREATE INDEX "billers_type_idx" ON "billers"("type");

-- CreateIndex
CREATE UNIQUE INDEX "biller_wallets_billerId_key" ON "biller_wallets"("billerId");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_billerWalletId_key" ON "ledger_accounts"("billerWalletId");

-- CreateIndex
CREATE UNIQUE INDEX "bill_definitions_billerId_key" ON "bill_definitions"("billerId");

-- CreateIndex
CREATE INDEX "biller_withdrawal_drafts_billerId_status_idx" ON "biller_withdrawal_drafts"("billerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "biller_withdrawal_drafts_resultingWithdrawalRequestId_key" ON "biller_withdrawal_drafts"("resultingWithdrawalRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "biller_report_preferences_userId_key" ON "biller_report_preferences"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "biller_payments_transactionId_key" ON "biller_payments"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "biller_payments_paystackReference_key" ON "biller_payments"("paystackReference");

-- CreateIndex
CREATE INDEX "biller_payments_billerId_status_idx" ON "biller_payments"("billerId", "status");

-- CreateIndex
CREATE INDEX "biller_payments_userId_idx" ON "biller_payments"("userId");

-- CreateIndex
CREATE INDEX "withdrawal_requests_billerId_idx" ON "withdrawal_requests"("billerId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_billerId_fkey" FOREIGN KEY ("billerId") REFERENCES "billers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_billerWalletId_fkey" FOREIGN KEY ("billerWalletId") REFERENCES "biller_wallets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_billerId_fkey" FOREIGN KEY ("billerId") REFERENCES "billers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billers" ADD CONSTRAINT "billers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biller_wallets" ADD CONSTRAINT "biller_wallets_billerId_fkey" FOREIGN KEY ("billerId") REFERENCES "billers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_definitions" ADD CONSTRAINT "bill_definitions_billerId_fkey" FOREIGN KEY ("billerId") REFERENCES "billers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biller_withdrawal_drafts" ADD CONSTRAINT "biller_withdrawal_drafts_billerId_fkey" FOREIGN KEY ("billerId") REFERENCES "billers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biller_withdrawal_drafts" ADD CONSTRAINT "biller_withdrawal_drafts_initiatedByUserId_fkey" FOREIGN KEY ("initiatedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biller_withdrawal_drafts" ADD CONSTRAINT "biller_withdrawal_drafts_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biller_withdrawal_drafts" ADD CONSTRAINT "biller_withdrawal_drafts_resultingWithdrawalRequestId_fkey" FOREIGN KEY ("resultingWithdrawalRequestId") REFERENCES "withdrawal_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biller_report_preferences" ADD CONSTRAINT "biller_report_preferences_billerId_fkey" FOREIGN KEY ("billerId") REFERENCES "billers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biller_report_preferences" ADD CONSTRAINT "biller_report_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biller_payments" ADD CONSTRAINT "biller_payments_billerId_fkey" FOREIGN KEY ("billerId") REFERENCES "billers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biller_payments" ADD CONSTRAINT "biller_payments_billDefinitionId_fkey" FOREIGN KEY ("billDefinitionId") REFERENCES "bill_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biller_payments" ADD CONSTRAINT "biller_payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biller_payments" ADD CONSTRAINT "biller_payments_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
