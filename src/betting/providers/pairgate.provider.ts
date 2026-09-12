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
 * category: Betting Providers (list), Verify Betting Customer, and Betting
 * Purchase, confirmed against their public docs
 * (https://pairgate.com/developers/introduction) on 2026-09-12. Bearer-token
 * auth, base URL https://pairgate.com/api/v1. Pairgate also documents a
 * sandbox: prefixing a purchase-style endpoint with `/test` (e.g.
 * `/test/betting/purchase`) simulates the call without moving real money —
 * useful for testing this end-to-end before going live with a funded
 * Pairgate wallet. Toggle it with PAIRGATE_USE_SANDBOX=true in .env.
 *
 * NOT YET CONFIRMED against a live account (no PAIRGATE_API_KEY has been
 * issued yet) — request/response field names below follow the documented
 * shape as closely as possible, matching the same "normalize on receipt"
 * pattern VtpassProvider uses, but should be re-verified against a real
 * sandbox response the first time this actually runs.
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
        this.http.get(`${this.baseUrl}/betting/providers`, { headers: this.authHeaders() }),
      );
      const list = res.data?.data ?? res.data?.providers ?? [];
      return list.map((p: any) => ({ id: p.id ?? p.code, name: p.name ?? p.id ?? p.code }));
    } catch (err) {
      this.logger.error(`Pairgate listProviders failed: ${(err as Error).message}`);
      return [];
    }
  }

  async verifyCustomer(params: { providerId: string; customerId: string }) {
    try {
      const res = await firstValueFrom(
        this.http.post(
          `${this.baseUrl}/betting/verify`,
          { provider: params.providerId, customer_id: params.customerId },
          { headers: this.authHeaders() },
        ),
      );
      const data = res.data?.data ?? res.data;
      return { valid: !!data?.valid || !!data?.customer_name, customerName: data?.customer_name };
    } catch (err) {
      this.logger.error(`Pairgate verifyCustomer failed: ${(err as Error).message}`);
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
          `${this.baseUrl}${this.path('/betting/purchase')}`,
          {
            request_id: params.requestId,
            provider: params.providerId,
            customer_id: params.customerId,
            amount: params.amount,
          },
          { headers: this.authHeaders() },
        ),
      );
      return this.mapResponse(res.data, params.requestId);
    } catch (err) {
      this.logger.error(`Pairgate purchase failed: ${(err as Error).message}`);
      return {
        status: 'failed',
        providerReference: params.requestId,
        message: (err as Error).message,
      };
    }
  }

  async requery(providerReference: string): Promise<BettingPurchaseResult> {
    const res = await firstValueFrom(
      this.http.get(`${this.baseUrl}/betting/status/${providerReference}`, {
        headers: this.authHeaders(),
      }),
    );
    return this.mapResponse(res.data, providerReference);
  }

  private mapResponse(data: any, fallbackReference: string): BettingPurchaseResult {
    const rawStatus = (data?.status ?? data?.data?.status ?? '').toString().toLowerCase();
    const status =
      rawStatus === 'success' || rawStatus === 'successful' || rawStatus === 'completed'
        ? 'success'
        : rawStatus === 'pending' || rawStatus === 'processing'
          ? 'pending'
          : 'failed';
    return {
      status,
      providerReference: data?.reference ?? data?.data?.reference ?? fallbackReference,
      message: data?.message ?? data?.data?.message,
    };
  }
}
