import { IsIn, IsNumberString, IsOptional, IsString } from 'class-validator';

export class PurchaseDto {
  @IsIn(['airtime', 'data', 'tv', 'electricity'])
  category!: 'airtime' | 'data' | 'tv' | 'electricity';

  @IsString()
  serviceId!: string; // e.g. "mtn", "dstv", "ikeja-electric"

  @IsOptional()
  @IsString()
  variationCode?: string; // required for data/tv bundle selection

  @IsString()
  customerId!: string; // phone number, smartcard number, or meter number

  @IsNumberString()
  amount!: string;

  @IsString()
  phone!: string;
}
