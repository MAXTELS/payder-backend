import { IsNumberString, IsString, Length, Matches } from 'class-validator';

// Nigerian bank account numbers (NUBAN) are standardized 10-digit numbers —
// enforced here rather than relying on the bank-selection UI, since the
// account number is manually typed twice by the customer.
const NUBAN_PATTERN = /^\d{10}$/;

export class CreateWithdrawalDto {
  @IsNumberString()
  amount!: string;

  @IsString()
  @Length(2, 100)
  bankName!: string;

  @Matches(NUBAN_PATTERN, { message: 'Account number must be exactly 10 digits' })
  accountNumber!: string;

  // Re-entered by the customer to catch typos before we commit to a payout —
  // WithdrawalsService.create() rejects if this doesn't match accountNumber.
  @Matches(NUBAN_PATTERN, { message: 'Confirm account number must be exactly 10 digits' })
  confirmAccountNumber!: string;

  @IsString()
  @Length(2, 100)
  accountName!: string;
}
