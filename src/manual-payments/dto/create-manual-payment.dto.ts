import { IsIn, IsNumberString, IsOptional, IsString, Length } from 'class-validator';

export class CreateManualPaymentDto {
  @IsIn(['REMITA', 'ETRANZACT'])
  biller!: 'REMITA' | 'ETRANZACT';

  @IsString()
  @Length(4, 30)
  invoiceReference!: string;

  @IsNumberString()
  amount!: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  payerName?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;
}
