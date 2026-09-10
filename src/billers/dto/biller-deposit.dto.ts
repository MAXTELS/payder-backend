import { IsNumberString } from 'class-validator';

export class BillerDepositDto {
  @IsNumberString({}, { message: 'amount must be a number' })
  amount!: string;
}
