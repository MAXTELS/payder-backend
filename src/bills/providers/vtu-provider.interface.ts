/**
 * Provider-agnostic interface for VTU-style purchases: airtime, data, TV,
 * electricity, and (via VtpassProvider specifically) exam pins. Swapping in
 * Baxi or ClubKonnect later, or adding one as a failover, means writing one
 * new class against this interface — see architecture doc §5.2/§6.
 */
export interface VtuPurchaseResult {
  status: 'success' | 'pending' | 'failed';
  providerReference: string;
  message?: string;
  // Present for pin-based products (exam pins, some data bundles).
  pin?: string;
  token?: string;
}

export interface VtuProvider {
  readonly name: string;

  verifyCustomer(params: {
    serviceId: string; // e.g. "ikeja-electric", "waec-registration"
    customerId: string; // meter number, smartcard number, phone, etc.
  }): Promise<{ customerName?: string; valid: boolean }>;

  purchase(params: {
    requestId: string; // idempotency key, must be unique per attempt
    serviceId: string;
    variationCode?: string;
    customerId: string;
    amount: string;
    phone: string;
  }): Promise<VtuPurchaseResult>;

  requery(providerReference: string): Promise<VtuPurchaseResult>;
}
