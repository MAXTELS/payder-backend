import { IsString, Length } from 'class-validator';

export class RejectWithdrawalDto {
  @IsString()
  @Length(1, 500)
  reason!: string;
}
