/**
 * Provider-agnostic interface for betting-account funding, deliberately
 * shaped like bills/providers/vtu-provider.interface.ts's VtuProvider —
 * same "verify, then purchase, then requery" flow, just a distinct interface
 * rather than reusing VtuProvider directly, since a betting purchase takes a
 * providerId (which platform) instead of a serviceId+variationCode pair, and
 * has no phone-recharge-style variation codes at all.
 */
export interface BettingPurchaseResult {
  status: 'success' | 'pending' | 'failed';
  providerReference: string;
  message?: string;
}

export interface BettingProviderOption {
  id: string; // e.g. "bet9ja", "sportybet" — what FundBettingDto.providerId expects
  name: string;
}

export interface BettingProvider {
  readonly name: string;

  listProviders(): Promise<BettingProviderOption[]>;

  verifyCustomer(params: {
    providerId: string;
    customerId: string;
  }): Promise<{ customerName?: string; valid: boolean }>;

  purchase(params: {
    requestId: string; // idempotency key, must be unique per attempt
    providerId: string;
    customerId: string;
    amount: string;
  }): Promise<BettingPurchaseResult>;

  requery(providerReference: string): Promise<BettingPurchaseResult>;
}
