import { IsString, Length } from 'class-validator';

export class RejectWalletFundingDto {
  @IsString()
  @Length(1, 500)
  reason!: string;
}
