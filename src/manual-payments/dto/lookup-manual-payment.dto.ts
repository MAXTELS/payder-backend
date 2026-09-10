import { IsIn, IsString, Length } from 'class-validator';

export class LookupManualPaymentDto {
  @IsIn(['REMITA', 'ETRANZACT'])
  biller!: 'REMITA' | 'ETRANZACT';

  @IsString()
  @Length(4, 30)
  invoiceReference!: string;
}
