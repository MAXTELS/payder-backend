import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class WalletTransferDto {
  // Recipient's 10-digit PAYDER wallet ID (see Wallet.walletId) — validated
  // more strictly (exactly 10 digits) inside WalletService.lookupWalletId/
  // transferToWallet; the DTO-level check just keeps obviously-wrong input
  // (empty string, etc.) from reaching the service at all.
  @IsString()
  toWalletId!: string;

  @IsNumber()
  @Min(1)
  amount!: number;

  // Optional here — transferToWallet calls verifyTransactionPin (common/
  // security/transaction-pin.util.ts), which gives its own clear error when
  // this is missing rather than a generic validation failure.
  @IsOptional()
  @IsString()
  pin?: string;
}
