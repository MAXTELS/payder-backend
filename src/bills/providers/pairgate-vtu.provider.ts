import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { VtuCategory, VtuProvider, VtuPurchaseResult, VtuVariation } from './vtu-provider.interface';

/**
 * Pairgate (https://pairgate.com/developers) as a second VtuProvider,
 * covering airtime/data/tv/electricity — the same account/API key already
 * used by betting/providers/pairgate.provider.ts (BETTING is a completely
 * separate class deliberately; see this file's sibling for why). Base URL
 * https://pairgate.com/api/v1, Bearer token, `/test/...` sandbox prefix on
 * every endpoint, envelope always `{code, status, data}` — same conventions
 * confirmed working for betting, re-confirmed here per-category against
 * live docs on 2026-09-13 (see project doc
 * claude/pairgate-api-full-reference.md for the full research this was
 * built from — keep that doc in sync if these endpoints change).
 *
 * KNOWN OPEN QUESTION — read before touching provider-id resolution:
 * `GET /providers/{airtime|data|tv}` returns ONLY `{id: <uuid>, name}`, no
 * slug — but every purchase/plan-lookup example for those three categories
 * uses a human-readable slug string ("mtn", "dstv", ...) as `provider_id`,
 * and nowhere in Pairgate's docs is that string shown coming from an API
 * response. `resolveProviderSlug()` below hardcodes the well-known network/
 * TV slugs from those doc examples rather than trusting the UUID (which is
 * unverified to even be accepted) — this MUST be smoke-tested against the
 * live API before relying on it in production; if a purchase 404s or
 * rejects provider_id, that's the first thing to check. Electricity has a
 * real `slug` field on its provider-list response, so it has no such
 * problem — see below.
 *
 * Electricity has never had a `serviceId` convention in this app before
 * (VTpass never actually implemented it — see vtpass.provider.ts's header
 * comment), so there's nothing to translate: `serviceId` for electricity IS
 * the Pairgate DISCO slug directly (e.g. "ikedc", "eko"), sourced from
 * `listProviders('electricity')` below. The frontend needs a DISCO picker
 * wired to that new endpoint (GET /bills/providers?category=electricity) —
 * not yet done as of this pass, flagged separately.
 *
 * Electricity and education are Pairgate's only async categories: purchase
 * deducts the wallet and confirms `status: true` synchronously, but the
 * actual token/pin is `null` until a webhook arrives later (or a
 * /transaction/status poll). Airtime/data/cable are fully synchronous.
 * purchase() below reports 'success' as soon as Pairgate confirms the debit
 * for ALL four categories (that's the financially meaningful event — money
 * has moved), leaving `token` undefined for electricity until the webhook
 * handler (backend/src/webhooks/pairgate-webhook.*) fills it in on the
 * Transaction record; BillsController's existing GET /bills/:id/status
 * polling route already covers a customer checking back for it.
 */
// PAYDER's flat data-bundle surcharge, added 2026-09-13 on top of whatever
// Pairgate actually charges for the plan — tiered by the PLAN'S OWN price
// (not the surcharge-inclusive total), applies to data bundles ONLY (not
// airtime/tv/electricity, which have no per-plan price list to tier against
// the same way). Baked directly into getDataPlans()'s returned `amount`
// below so the price the customer sees in the plan list IS the price
// they're charged — BillsService.purchase re-derives its authoritative
// price from this same getVariations() call for the chosen variationCode,
// so there's exactly one place this needs to be correct.
function applyDataSurcharge(basePrice: number): number {
  if (basePrice < 500) return basePrice + 10;
  if (basePrice < 1000) return basePrice + 20;
  return basePrice + 50;
}

@Injectable()
export class PairgateVtuProvider implements VtuProvider {
  readonly name = 'pairgate-vtu';
  private readonly logger = new Logger(PairgateVtuProvider.name);

  constructor(
    private http: HttpService,
    private config: ConfigService,
  ) {}

  private get baseUrl() {
    return this.config.get<string>('PAIRGATE_BASE_URL') ?? 'https://pairgate.com/api/v1';
  }

  private get useSandbox() {
    return this.config.get<string>('PAIRGATE_USE_SANDBOX') === 'true';
  }

  private authHeaders() {
    return { Authorization: `Bearer ${this.config.get<string>('PAIRGATE_API_KEY')}` };
  }

  private path(p: string) {
    return this.useSandbox ? `/test${p}` : p;
  }

  // See this file's header comment — hardcodes the slug strings Pairgate's
  // OWN docs use in purchase examples, since the provider-list endpoint for
  // these three categories doesn't return a slug to source them from.
  // Electricity/tv pass `serviceId` through unchanged (see header comment).
  private resolveProviderSlug(serviceId: string, category: VtuCategory): string {
    const s = serviceId.toLowerCase().trim();
    if (category === 'electricity' || category === 'tv') return s;
    // airtime / data — strip VTpass's "-data" suffix convention if present,
    // then map the one network whose Pairgate slug differs from VTpass's.
    const base = s.replace(/-data$/, '');
    const aliases: Record<string, string> = { etisalat: '9mobile' };
    return aliases[base] ?? base;
  }

  /**
   * Not part of VtuProvider (VTpass has no equivalent concept exposed
   * through this interface) — used by a new BillsController endpoint so the
   * frontend can populate a provider picker, primarily for electricity
   * (which has no other source of DISCO names) but usable for any category.
   */
  async listProviders(
    category: VtuCategory,
  ): Promise<Array<{ id: string; name: string; slug?: string }>> {
    try {
      const res = await firstValueFrom(
        this.http.get(`${this.baseUrl}${this.path(`/providers/${category}`)}`, {
          headers: { ...this.authHeaders(), 'Cache-Control': 'no-cache' },
        }),
      );
      return (res.data?.data ?? []).map((p: any) => ({ id: p.id, name: p.name, slug: p.slug }));
    } catch (err: any) {
      const detail = err?.response?.data ?? err?.message ?? err;
      this.logger.error(`Pairgate listProviders(${category}) failed: ${JSON.stringify(detail)}`);
      return [];
    }
  }

  async getVariations(serviceId: string, category?: VtuCategory): Promise<VtuVariation[]> {
    if (category === 'tv') return this.getCablePlans(serviceId);
    if (category === 'data') return this.getDataPlans(serviceId);
    // Airtime and electricity are amount-based, no variation list.
    return [];
  }

  private async getCablePlans(serviceId: string): Promise<VtuVariation[]> {
    try {
      const providerId = this.resolveProviderSlug(serviceId, 'tv');
      const res = await firstValueFrom(
        this.http.get(`${this.baseUrl}${this.path('/cable-plans')}`, {
          params: { provider_id: providerId },
          headers: this.authHeaders(),
        }),
      );
      // Response is `{ "DSTV": [ {plan_id, name, price} ] }` grouped by
      // provider display name — we only asked for one provider, so flatten
      // every group present (normally exactly one) rather than assuming the
      // exact key casing Pairgate chooses to use for it.
      const groups: Record<string, any[]> = res.data?.data ?? {};
      const plans = Object.values(groups).flat();
      return plans.map((p: any) => ({
        code: String(p.plan_id),
        name: p.name,
        amount: String(p.price),
      }));
    } catch (err: any) {
      const detail = err?.response?.data ?? err?.message ?? err;
      this.logger.error(`Pairgate getCablePlans failed: ${JSON.stringify(detail)}`);
      return [];
    }
  }

  private async getDataPlans(serviceId: string): Promise<VtuVariation[]> {
    try {
      const providerId = this.resolveProviderSlug(serviceId, 'data');
      // Pairgate has no "all plans for this provider" call — plans are
      // fetched per plan_type (CG/SME/GIFTING/...), and which plan_types
      // exist per provider is itself a separate lookup. Discover them, then
      // fan out. `categories` response uses the provider UUID, not the
      // slug, so match on provider_name instead (case-insensitive against
      // our own slug->name expectation — good enough since these are fixed,
      // well-known network names).
      const catRes = await firstValueFrom(
        this.http.get(`${this.baseUrl}${this.path('/data-plans/categories')}`, {
          headers: this.authHeaders(),
        }),
      );
      const allCategories: any[] = catRes.data?.data ?? [];
      const planTypes = allCategories
        .filter((c) => (c.provider_name ?? '').toLowerCase() === providerId.toLowerCase())
        .map((c) => c.plan_type);
      if (planTypes.length === 0) {
        this.logger.warn(
          `Pairgate getDataPlans: no plan_type categories matched provider "${providerId}" — falling back to no variations`,
        );
        return [];
      }
      const perType = await Promise.all(
        planTypes.map((planType) =>
          firstValueFrom(
            this.http.get(`${this.baseUrl}${this.path('/data-plans')}`, {
              params: { provider_id: providerId, plan_type: planType },
              headers: this.authHeaders(),
            }),
          )
            .then((res) => {
              const groups: Record<string, any[]> = res.data?.data ?? {};
              return Object.values(groups)
                .flat()
                .map((p: any) => ({
                  code: String(p.plan_id),
                  name: `${p.name} (${planType})`,
                  amount: String(applyDataSurcharge(Number(p.price))),
                }));
            })
            .catch((err: any) => {
              this.logger.error(
                `Pairgate getDataPlans(${providerId}, ${planType}) failed: ${JSON.stringify(err?.response?.data ?? err?.message)}`,
              );
              return [] as VtuVariation[];
            }),
        ),
      );
      return perType.flat();
    } catch (err: any) {
      const detail = err?.response?.data ?? err?.message ?? err;
      this.logger.error(`Pairgate getDataPlans failed: ${JSON.stringify(detail)}`);
      return [];
    }
  }

  async verifyCustomer(params: {
    serviceId: string;
    customerId: string;
    category?: VtuCategory;
    meterType?: 1 | 2;
  }) {
    if (params.category === 'tv') return this.verifyCable(params);
    if (params.category === 'electricity') return this.verifyElectricity(params);
    // Airtime/data have no verify concept on Pairgate (nor did they on
    // VTpass) — BillsService should never route these categories here.
    return { valid: false };
  }

  private async verifyCable(params: { serviceId: string; customerId: string }) {
    try {
      const providerId = this.resolveProviderSlug(params.serviceId, 'tv');
      const res = await firstValueFrom(
        this.http.post(
          `${this.baseUrl}${this.path('/cable/verify')}`,
          { provider_id: providerId, smartcard: params.customerId },
          { headers: this.authHeaders() },
        ),
      );
      const data = res.data?.data ?? {};
      return { valid: !!data.status, customerName: data.customer_name };
    } catch (err: any) {
      const detail = err?.response?.data ?? err?.message ?? err;
      this.logger.error(`Pairgate verifyCable failed: ${JSON.stringify(detail)}`);
      return { valid: false };
    }
  }

  private async verifyElectricity(params: {
    serviceId: string;
    customerId: string;
    meterType?: 1 | 2;
  }) {
    try {
      const providerId = this.resolveProviderSlug(params.serviceId, 'electricity');
      const res = await firstValueFrom(
        this.http.post(
          `${this.baseUrl}${this.path('/electricity/verify')}`,
          {
            provider_id: providerId,
            meter_number: params.customerId,
            meter_type: params.meterType ?? 1,
          },
          { headers: this.authHeaders() },
        ),
      );
      const data = res.data?.data ?? {};
      // Pairgate's electricity/verify does not return an address field
      // (confirmed against live docs) — `address` on the interface stays
      // undefined here; only customerName is available to show the
      // customer for a sanity check before purchase.
      return { valid: !!data.status, customerName: data.customer_name };
    } catch (err: any) {
      const detail = err?.response?.data ?? err?.message ?? err;
      this.logger.error(`Pairgate verifyElectricity failed: ${JSON.stringify(detail)}`);
      return { valid: false };
    }
  }

  async purchase(params: {
    requestId: string;
    serviceId: string;
    variationCode?: string;
    customerId?: string;
    amount: string | number;
    phone: string;
    subscriptionType?: 'change' | 'renew';
    category?: VtuCategory;
    meterType?: 1 | 2;
  }): Promise<VtuPurchaseResult> {
    const category = params.category;
    try {
      let endpoint: string;
      let body: Record<string, unknown>;
      switch (category) {
        case 'airtime':
          endpoint = '/airtime/purchase';
          body = {
            provider_id: this.resolveProviderSlug(params.serviceId, 'airtime'),
            amount: params.amount,
            recipient: params.phone,
            reference: params.requestId,
          };
          break;
        case 'data':
          endpoint = '/data/purchase';
          body = {
            provider_id: this.resolveProviderSlug(params.serviceId, 'data'),
            plan_id: params.variationCode,
            recipient: params.phone,
            reference: params.requestId,
          };
          break;
        case 'tv':
          endpoint = '/cable/purchase';
          body = {
            provider_id: this.resolveProviderSlug(params.serviceId, 'tv'),
            plan_id: params.variationCode,
            smartcard: params.customerId,
            reference: params.requestId,
          };
          break;
        case 'electricity':
          endpoint = '/electricity/purchase';
          body = {
            provider_id: this.resolveProviderSlug(params.serviceId, 'electricity'),
            amount: params.amount,
            meter_number: params.customerId,
            meter_type: params.meterType ?? 1,
            reference: params.requestId,
          };
          break;
        default:
          throw new Error(`PairgateVtuProvider.purchase called without a valid category: ${category}`);
      }
      const res = await firstValueFrom(
        this.http.post(`${this.baseUrl}${this.path(endpoint)}`, body, {
          headers: this.authHeaders(),
        }),
      );
      const mapped = this.mapResponse(res.data, params.requestId);
      // Electricity is Pairgate's one async category here (see header
      // comment) — a confirmed debit with no token yet is left 'pending' so
      // BillsService leaves the Transaction PROCESSING rather than SUCCESS,
      // which is what makes both the webhook handler and GET
      // /bills/:id/status have something to actually resolve later. Every
      // other category's token/pin concept doesn't apply, so a confirmed
      // debit there really is the end of the story.
      if (category === 'electricity' && mapped.status === 'success' && !mapped.token) {
        return { ...mapped, status: 'pending' };
      }
      return mapped;
    } catch (err: any) {
      const detail = err?.response?.data ?? err?.message ?? err;
      this.logger.error(`Pairgate purchase(${category}) failed: ${JSON.stringify(detail)}`);
      return {
        status: 'failed',
        providerReference: params.requestId,
        message: err?.response?.data?.message ?? (err as Error).message,
      };
    }
  }

  async requery(providerReference: string): Promise<VtuPurchaseResult> {
    try {
      const res = await firstValueFrom(
        this.http.get(`${this.baseUrl}${this.path('/transaction/status')}`, {
          params: { reference_code: providerReference },
          headers: { ...this.authHeaders(), 'Cache-Control': 'no-cache' },
        }),
      );
      return this.mapResponse(res.data, providerReference);
    } catch (err: any) {
      const detail = err?.response?.data ?? err?.message ?? err;
      this.logger.error(`Pairgate requery failed: ${JSON.stringify(detail)}`);
      // Same reasoning as every other provider's requery here: a failed
      // STATUS CHECK doesn't mean the purchase failed — report 'pending' so
      // the caller doesn't reverse a debit that may well have gone through.
      return { status: 'pending', providerReference, message: (err as Error).message };
    }
  }

  /**
   * Normalizes THREE distinct shapes seen across airtime/data/cable/
   * electricity purchase and /transaction/status responses:
   *  - live success: `data.status === true`, with `balance_before`/
   *    `balance_after`/`amount` present — money has moved, treated as
   *    'success' (see header comment on why electricity's missing token
   *    doesn't change this).
   *  - sandbox/test-mode: `data.test_mode === true`, no real
   *    `reference_code` to poll later — same fix already applied to the
   *    betting provider for the identical Pairgate sandbox behavior.
   *  - `/transaction/status` (used by requery, both live and sandbox):
   *    `data.status` as a STRING ("successful"|"pending"|"failed"), not a
   *    boolean — same distinction the betting provider's mapResponse
   *    already handles.
   * The "item purchased" field is named `plan` for airtime/data/cable but
   * `item` for electricity — neither is read here since VtuPurchaseResult
   * has no such field; only status/reference/message/pin/token matter.
   */
  private mapResponse(data: any, fallbackReference: string): VtuPurchaseResult {
    const inner = data?.data ?? {};

    if (inner.test_mode === true) {
      return {
        status: 'success',
        providerReference: inner.reference_code ?? fallbackReference,
        message: inner.message ?? 'Test purchase successful (sandbox — no balance deducted).',
      };
    }

    const raw = inner.status;
    let status: 'success' | 'pending' | 'failed';
    if (typeof raw === 'boolean') {
      status = raw ? 'success' : 'failed';
    } else {
      const rawStr = (raw ?? '').toString().toLowerCase();
      status =
        rawStr === 'success' || rawStr === 'successful' || rawStr === 'completed'
          ? 'success'
          : rawStr === 'pending' || rawStr === 'processing'
            ? 'pending'
            : 'failed';
    }
    return {
      status,
      providerReference: inner.reference_code ?? fallbackReference,
      message: inner.message,
      // Electricity token / any future pin-bearing category: not present in
      // the synchronous response (see header comment) — left undefined here
      // and filled in later by the Pairgate webhook handler against the
      // stored Transaction record.
      pin: inner.pin ?? undefined,
      token: inner.pin ?? undefined,
    };
  }
}
