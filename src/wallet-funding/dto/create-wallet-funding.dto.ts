import { IsIn, IsNumberString, IsString, Length } from 'class-validator';

// Keys for the static PAYDER-owned bank accounts shown in the app. Kept as an
// enum-like union here (not a DB table) because these three accounts are
// fixed, hand-entered values — see WALLET_FUNDING_DESTINATIONS in
// wallet-funding.service.ts for the display strings.
export const WALLET_FUNDING_DESTINATION_KEYS = ['ACCESS_BANK', 'OPAY', 'MONIEPOINT'] as const;
export type WalletFundingDestinationKey = (typeof WALLET_FUNDING_DESTINATION_KEYS)[number];

export class CreateWalletFundingDto {
  @IsNumberString()
  amount!: string;

  @IsIn(WALLET_FUNDING_DESTINATION_KEYS)
  destinationAccount!: WalletFundingDestinationKey;

  @IsString()
  @Length(2, 100)
  senderAccountName!: string;

  @IsString()
  @Length(2, 100)
  senderBankName!: string;
}
