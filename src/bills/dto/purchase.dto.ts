import { IsIn, IsNumberString, IsOptional, IsString } from 'class-validator';

export class PurchaseDto {
  @IsIn(['airtime', 'data', 'tv', 'electricity'])
  category!: 'airtime' | 'data' | 'tv' | 'electricity';

  @IsString()
  serviceId!: string; // e.g. "mtn", "mtn-data", "dstv"

  // Required by BillsService for 'data' and 'tv' (a bundle/bouquet pick);
  // unused for 'airtime'. Enforced in the service, not here, since the
  // requirement is conditional on `category`.
  @IsOptional()
  @IsString()
  variationCode?: string;

  @IsString()
  customerId!: string; // phone number, smartcard number, or meter number

  // For 'airtime' this is the actual amount charged. For 'data'/'tv' it's
  // ignored — BillsService re-derives the authoritative price from VTpass's
  // own service-variations lookup for the chosen variationCode, the same
  // "never trust the client with a money figure" rule the Remita and
  // Paystack integrations already follow. Still required here so the
  // client always has *a* value to show as a receipt/confirmation amount.
  @IsNumberString()
  amount!: string;

  @IsString()
  phone!: string;

  // Optional at the DTO level on purpose — BillsService.purchase calls
  // verifyTransactionPin (common/security/transaction-pin.util.ts), which
  // throws its own clear "set a PIN" / "enter your PIN" message when this is
  // missing rather than a generic class-validator error.
  @IsOptional()
  @IsString()
  pin?: string;
}
