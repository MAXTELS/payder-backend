import { Matches } from 'class-validator';

export class ApproveBillerWithdrawalDto {
  @Matches(/^\d{4,6}$/, { message: 'pin must be 4-6 digits' })
  pin!: string;
}
