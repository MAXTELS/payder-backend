import { IsNumberString, IsString, Length, Matches } from 'class-validator';

const NUBAN_PATTERN = /^\d{10}$/;
const PIN_PATTERN = /^\d{4,6}$/;

// Same shape as withdrawals/dto/create-withdrawal.dto.ts, plus the PIN a
// biller-user enters as their consent (initiator PIN for a single biller or
// the first signer of a joint one — see BillersService.initiateWithdrawal).
export class BillerWithdrawDto {
  @IsNumberString()
  amount!: string;

  @IsString()
  @Length(2, 100)
  bankName!: string;

  @Matches(NUBAN_PATTERN, { message: 'Account number must be exactly 10 digits' })
  accountNumber!: string;

  @Matches(NUBAN_PATTERN, { message: 'Confirm account number must be exactly 10 digits' })
  confirmAccountNumber!: string;

  @IsString()
  @Length(2, 100)
  accountName!: string;

  @Matches(PIN_PATTERN, { message: 'pin must be 4-6 digits' })
  pin!: string;
}
