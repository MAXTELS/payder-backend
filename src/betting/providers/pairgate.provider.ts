import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import {
  BettingProvider,
  BettingProviderOption,
  BettingPurchaseResult,
} from './betting-provider.interface';

/**
 * Pairgate (https://pairgate.com/developers) is a Nigerian VTU aggregator —
 * like VTpass, but this integration only uses its "Betting" service
 * category. Bearer-token auth, base URL https://pairgate.com/api/v1.
 *
 * 2026-09-12: re-verified against Pairgate's actual published docs (the
 * first pass of this file guessed at endpoint shapes before an account
 * existed, and got them wrong — production was returning 404s on every call
 * because the real paths/field names differ from the initial guess). Real
 * endpoints, confirmed against pairgate.com/developers/{providers-by-type,
 * betting-providers,betting-verify,betting-purchase,transaction-status}:
 *
 *   GET  /providers/betting                     -> list betting platforms
 *   POST /bet/verify    { provider_id, customer_id }
 *   POST /bet/purchase  { provider_id, amount, customer_id, reference }
 *   GET  /transaction/status?reference_code=... -> poll a purchase's outcome
 *
 * 2026-09-12: re-verified against pairgate.com/developers/{betting-providers,
 * betting-verify,betting-purchase,transaction-status} and found EVERY one of
 * these four endpoints — not just purchase — has a separate `/test/...`
 * sandbox path (e.g. GET /test/providers/betting), and a sandbox API key is
 * only valid against the `/test/...` paths. This file previously only
 * applied the `/test` prefix to the purchase call; listProviders/
 * verifyCustomer/requery hit the production paths unconditionally, which is
 * exactly why "Betting providers could not be loaded" was showing even
 * though nothing else looked wrong yet — a sandbox key against the
 * production /providers/betting endpoint fails (401/403), listProviders
 * catches that and returns [], and the customer sees an empty dropdown. All
 * four methods now go through `this.path()` consistently.
 *
 * Every response is wrapped as { code, status: "success"|..., data: {...} }.
 * `reference` (sent) and `reference_code` (returned) are NOT the same value
 * — Pairgate mints its own reference_code for the transaction, and that's
 * what /transaction/status expects back, not the reference we sent. Toggle
 * sandbox with PAIRGATE_USE_SANDBOX=true in .env.
 */
@Injectable()
export class PairgateProvider implements BettingProvider {
  readonly name = 'pairgate';
  private readonly logger = new Logger(PairgateProvider.name);

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

  async listProviders(): Promise<BettingProviderOption[]> {
    try {
      const res = await firstValueFrom(
        this.http.get(`${this.baseUrl}${this.path('/providers/betting')}`, {
          headers: { ...this.authHeaders(), 'Cache-Control': 'no-cache' },
        }),
      );
      const list = res.data?.data ?? [];
      return list.map((p: any) => ({ id: p.slug ?? p.id, name: p.name ?? p.slug ?? p.id }));
    } catch (err: any) {
      const detail = err?.response?.data ?? err?.message ?? err;
      this.logger.error(`Pairgate listProviders failed: ${JSON.stringify(detail)}`);
      return [];
    }
  }

  async verifyCustomer(params: { providerId: string; customerId: string }) {
    try {
      const res = await firstValueFrom(
        this.http.post(
          `${this.baseUrl}${this.path('/bet/verify')}`,
          { provider_id: params.providerId, customer_id: params.customerId },
          { headers: this.authHeaders() },
        ),
      );
      const data = res.data?.data ?? {};
      return { valid: !!data.status, customerName: data.customer_name };
    } catch (err: any) {
      const detail = err?.response?.data ?? err?.message ?? err;
      this.logger.error(`Pairgate verifyCustomer failed: ${JSON.stringify(detail)}`);
      return { valid: false };
    }
  }

  async purchase(params: {
    requestId: string;
    providerId: string;
    customerId: string;
    amount: string;
  }): Promise<BettingPurchaseResult> {
    try {
      const res = await firstValueFrom(
        this.http.post(
          `${this.baseUrl}${this.path('/bet/purchase')}`,
          {
            // Pairgate mints its own reference_code for status polling — the
            // `reference` we send here is just OUR de-duplication key on
            // their side (8-100 chars; our Prisma transaction id fits fine).
            reference: params.requestId,
            provider_id: params.providerId,
            customer_id: params.customerId,
            amount: params.amount,
          },
          { headers: this.authHeaders() },
        ),
      );
      return this.mapResponse(res.data, params.requestId);
    } catch (err: any) {
      const detail = err?.response?.data ?? err?.message ?? err;
      this.logger.error(`Pairgate purchase failed: ${JSON.stringify(detail)}`);
      return {
        status: 'failed',
        providerReference: params.requestId,
        message: err?.response?.data?.message ?? (err as Error).message,
      };
    }
  }

  async requery(providerReference: string): Promise<BettingPurchaseResult> {
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
      // Same reasoning as VtpassProvider.requery: a failure on the STATUS
      // CHECK itself doesn't mean the funding failed — report 'pending' so
      // BettingService.checkStatus doesn't reverse a wallet debit for a
      // funding that may well have gone through; the caller just retries.
      return { status: 'pending', providerReference, message: (err as Error).message };
    }
  }

  /**
   * Two different response shapes to normalize here: the purchase endpoint
   * returns `data.status` as a BOOLEAN (true = accepted, now processing —
   * its own message literally says "successful & processing", so a bare
   * `true` is treated as 'pending' rather than 'success' and left for
   * /transaction/status or the webhook to resolve), while transaction/status
   * returns `data.status` as a STRING ("successful" | "pending" | "failed").
   * `data.reference_code` (Pairgate's own generated id, NOT the `reference`
   * we sent) is what must be stored as providerReference for later polling.
   */
  private mapResponse(data: any, fallbackReference: string): BettingPurchaseResult {
    const raw = data?.data?.status;
    let status: 'success' | 'pending' | 'failed';
    if (typeof raw === 'boolean') {
      status = raw ? 'pending' : 'failed';
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
      providerReference: data?.data?.reference_code ?? fallbackReference,
      message: data?.data?.message,
    };
  }
}
