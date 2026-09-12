/**
 * Provider-agnostic interface for VTU-style purchases: airtime, data, TV,
 * electricity, and (via VtpassProvider specifically) exam pins. Swapping in
 * Baxi or ClubKonnect later, or adding one as a failover, means writing one
 * new class against this interface — see architecture doc §5.2/§6.
 */

// Normalized shape for a "variation" (a data bundle plan, a TV bouquet) —
// deliberately not VTpass's raw field names (variation_code/variation_amount)
// so callers (BillsService, the frontends) never couple to one provider's
// wire format, same reasoning as VtuPurchaseResult below.
export interface VtuVariation {
  code: string;
  name: string;
  amount: string;
}

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

  // Lists the purchasable options for a variation-priced service — data
  // bundle plans for a "*-data" serviceId, bouquets for a TV serviceId.
  // Airtime has no variations (it's a free-typed amount) and never calls
  // this. The returned `amount` is the provider's own authoritative price —
  // BillsService uses it to override whatever the client sent, rather than
  // trusting a client-supplied amount for a variation-priced product.
  getVariations(serviceId: string): Promise<VtuVariation[]>;

  verifyCustomer(params: {
    serviceId: string; // e.g. "dstv", "ikeja-electric"
    customerId: string; // smartcard number, meter number, etc.
  }): Promise<{ customerName?: string; valid: boolean }>;

  purchase(params: {
    requestId: string; // idempotency key, must be unique per attempt
    serviceId: string;
    variationCode?: string; // data bundle / TV bouquet — omitted for airtime
    customerId?: string; // billersCode — omitted for airtime (VTpass takes phone only)
    amount: string | number;
    phone: string;
    // TV-only: "change" picks/changes to the given variation_code, "renew"
    // repeats the customer's current bouquet without one. PAYDER's flow
    // always has the customer pick a bouquet from a list, so this is
    // always "change" in practice — see BillsService.purchase.
    subscriptionType?: 'change' | 'renew';
  }): Promise<VtuPurchaseResult>;

  requery(providerReference: string): Promise<VtuPurchaseResult>;
}
