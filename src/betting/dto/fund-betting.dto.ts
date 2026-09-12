import { IsNumberString, IsString } from 'class-validator';

export class FundBettingDto {
  // Pairgate's own provider code for the platform being funded — e.g.
  // "bet9ja", "sportybet", "1xbet" — fetched from GET /betting (see
  // BettingService.listProviders) rather than hardcoded, since Pairgate can
  // add/remove supported platforms on their end.
  @IsString()
  providerId!: string;

  // The customer's account ID/username on that betting platform — this is
  // what BettingService.verifyCustomer checks before a purchase is allowed,
  // same "verify before you pay" shape as VtuProvider.verifyCustomer.
  @IsString()
  customerId!: string;

  @IsNumberString()
  amount!: string;
}
