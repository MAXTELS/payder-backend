import { IsString, Length } from 'class-validator';

export class RejectManualPaymentDto {
  @IsString()
  @Length(1, 500)
  reason!: string;
}
