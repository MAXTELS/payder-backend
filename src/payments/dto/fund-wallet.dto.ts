import { IsNumberString } from 'class-validator';

export class FundWalletDto {
  // Digits only — the frontend's AmountInput already strips commas before
  // sending, this just double-checks server-side.
  @IsNumberString()
  amount!: string;
}
