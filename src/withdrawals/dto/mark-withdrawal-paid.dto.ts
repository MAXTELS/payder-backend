import { IsOptional, IsString, Length } from 'class-validator';

export class MarkWithdrawalPaidDto {
  // Optional — the admin's own bank-transfer reference/receipt number, kept
  // for support/audit purposes only. Nothing in the ledger depends on it.
  @IsOptional()
  @IsString()
  @Length(1, 200)
  providerConfirmationRef?: string;
}
