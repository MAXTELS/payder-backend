/**
 * Provider-agnostic interface for VTU-style purchases: airtime, data, TV,
 * electricity, and (via VtpassProvider specifically) exam pins. Swapping in
 * Baxi or ClubKonnect later, or adding one as a failover, means writing one
 * new class against this interface — see architecture doc §5.2/§6.
 *
 * 2026-09-13: added an explicit `category` param to verifyCustomer/purchase,
 * and to getVariations, ahead of wiring PairgateVtuProvider in alongside
 * VtpassProvider. VTpass's own `serviceId` catalog already fully disambig-
 * uates category on its own (e.g. "mtn" vs "mtn-data" vs "dstv"), which is
 * why the original interface never needed one — but Pairgate categorizes by
 * an explicit type (data/airtime/tv/electricity) plus a separate provider
 * id/slug, with no equivalent single composed serviceId scheme. Rather than
 * have a Pairgate provider guess category from serviceId shape, the caller
 * (BillsService, which already knows `dto.category`) now passes it through
 * explicitly. VtpassProvider accepts and ignores it — its own serviceId
 * scheme needs no help disambiguating.
 *
 * Also added `meterType` (1 = prepaid, 2 = postpaid) for electricity, which
 * neither this interface nor VtpassProvider had ever wired up before (see
 * VtpassProvider's header comment — electricity was never actually
 * implemented there, only declared in the DTO). Pairgate requires it on
 * both electricity/verify and electricity/purchase.
 */
export type VtuCategory = 'airtime' | 'data' | 'tv' | 'electricity';

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
  getVariations(serviceId: string, category?: VtuCategory): Promise<VtuVariation[]>;

  verifyCustomer(params: {
    serviceId: string; // e.g. "dstv", "ikeja-electric"
    customerId: string; // smartcard number, meter number, etc.
    category?: VtuCategory;
    // Electricity only: 1 = prepaid, 2 = postpaid. Pairgate requires this on
    // electricity/verify; VTpass never implemented electricity so ignores it.
    meterType?: 1 | 2;
  }): Promise<{
    customerName?: string;
    valid: boolean;
    // DSTV/GOtv are subscription-style: Status is 'ACTIVE'/'INACTIVE' and
    // dueDate is when the CURRENT bouquet lapses (renew before this to
    // avoid a gap in service). Neither is present for StarTimes — its
    // decoder is a prepaid balance, not a subscription with an expiry (see
    // `balance` below) — confirmed against vtpass.com/documentation/
    // dstv-subscription-api/, gotv-subscription-api/, and
    // startimes-subscription-api/.
    status?: string;
    dueDate?: string;
    customerNumber?: string;
    // StarTimes only: the decoder's current prepaid balance (VTpass
    // returns this instead of a Status/Due_Date pair). Not applicable to
    // DSTV/GOtv.
    balance?: string;
    // Electricity only (Pairgate): the meter's registered address, when the
    // provider returns one — purely informational, shown to the customer
    // alongside customerName for a sanity check before purchase.
    address?: string;
  }>;

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
    category?: VtuCategory;
    meterType?: 1 | 2; // electricity only
  }): Promise<VtuPurchaseResult>;

  requery(providerReference: string): Promise<VtuPurchaseResult>;
}
