import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { VtuProvider, VtuPurchaseResult, VtuVariation } from './vtu-provider.interface';

/**
 * VTpass covers airtime, data, TV, electricity, and — importantly for
 * PAYDER's exam-services feature — WAEC result-checker pins and JAMB e-PIN
 * vending (confirmed against https://vtpass.com/documentation/). NECO is
 * NOT confirmed on VTpass as of this writing; see architecture doc §5.3/§5.5
 * — treat NECO as a Phase 2 item pending a specific aggregator confirmation.
 *
 * Electricity and insurance are deliberately out of scope for this provider
 * class for now (2026-09-12 decision) — only airtime/data/TV are wired to
 * real endpoints below. The interface supports electricity fine (it's just
 * another variation-less/variation-priced billersCode purchase); add it here
 * without touching BillsService's shape when it's actually wanted.
 *
 * Going from VTpass sandbox to live is meant to be an .env-only change:
 * VTPASS_BASE_URL (sandbox.vtpass.com -> vtpass.com) and the three VTPASS_*
 * keys. Nothing in this file should ever hardcode "sandbox" or "live".
 */
@Injectable()
export class VtpassProvider implements VtuProvider {
  readonly name = 'vtpass';
  private readonly logger = new Logger(VtpassProvider.name);

  constructor(
    private http: HttpService,
    private config: ConfigService,
  ) {}

  private get baseUrl() {
    return this.config.get<string>('VTPASS_BASE_URL');
  }

  // GET requests (service-variations, service-categories) authenticate with
  // api-key + public-key; POST requests (merchant-verify, pay, requery)
  // authenticate with api-key + secret-key. VTpass treats these as two
  // separate credential pairs, not one — see
  // https://vtpass.com/documentation/authentication/. Mixing them up is a
  // common integration mistake, so this is split into two methods rather
  // than one generic authHeaders() to make it impossible to use the wrong
  // one for a given verb.
  private getHeaders() {
    return {
      'api-key': this.config.get<string>('VTPASS_API_KEY'),
      'public-key': this.config.get<string>('VTPASS_PUBLIC_KEY'),
    };
  }

  private postHeaders() {
    return {
      'api-key': this.config.get<string>('VTPASS_API_KEY'),
      'secret-key': this.config.get<string>('VTPASS_SECRET_KEY'),
    };
  }

  // `category` accepted-and-ignored — VTpass's serviceId scheme already
  // fully disambiguates (e.g. "mtn-data" vs "dstv"); it's only needed by
  // PairgateVtuProvider. See vtu-provider.interface.ts's header comment.
  async getVariations(serviceId: string, _category?: string): Promise<VtuVariation[]> {
    const res = await firstValueFrom(
      this.http.get(`${this.baseUrl}/service-variations`, {
        params: { serviceID: serviceId },
        headers: this.getHeaders(),
      }),
    );
    // VTpass has shipped this under both `varations` (a documented typo in
    // some responses) and `variations` historically — check both rather
    // than silently returning an empty list if they're on the typo'd one.
    const raw: any[] = res.data?.content?.varations ?? res.data?.content?.variations ?? [];
    return raw.map((v) => ({
      code: v.variation_code,
      name: v.name,
      amount: v.variation_amount,
    }));
  }

  async verifyCustomer(params: {
    serviceId: string;
    customerId: string;
    category?: string;
    meterType?: 1 | 2;
  }) {
    try {
      const res = await firstValueFrom(
        this.http.post(
          `${this.baseUrl}/merchant-verify`,
          { serviceID: params.serviceId, billersCode: params.customerId },
          { headers: this.postHeaders() },
        ),
      );
      const content = res.data?.content;
      // DSTV/GOtv return Status + Due_Date (subscription-style — see
      // vtu-provider.interface.ts's doc comment); StarTimes returns Balance
      // instead (prepaid decoder — no Status/Due_Date at all). Pull
      // whichever fields VTpass actually sent rather than assuming one
      // shape, so this works for all three without a per-provider branch.
      return {
        valid: res.data?.code === '000' && !!content,
        customerName: content?.Customer_Name,
        status: content?.Status,
        dueDate: content?.Due_Date,
        customerNumber: content?.Customer_Number,
        balance: content?.Balance !== undefined ? String(content.Balance) : undefined,
      };
    } catch (err) {
      this.logger.error(`VTpass verifyCustomer failed: ${(err as Error).message}`);
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
    category?: string;
    meterType?: 1 | 2;
  }): Promise<VtuPurchaseResult> {
    try {
      // VTpass's own docs show plain airtime's request body as JUST
      // request_id/serviceID/amount/phone — no billersCode. Sending only
      // the fields that actually apply (rather than billersCode: undefined
      // etc. on every request) matches that exactly and avoids a stray
      // field confusing a service that keys behavior off which fields are
      // present.
      const body: Record<string, unknown> = {
        request_id: params.requestId,
        serviceID: params.serviceId,
        amount: params.amount,
        phone: params.phone,
      };
      if (params.customerId) body.billersCode = params.customerId;
      if (params.variationCode) body.variation_code = params.variationCode;
      if (params.subscriptionType) body.subscription_type = params.subscriptionType;

      const res = await firstValueFrom(
        this.http.post(`${this.baseUrl}/pay`, body, { headers: this.postHeaders() }),
      );
      return this.mapResponse(res.data, params.requestId);
    } catch (err) {
      this.logger.error(`VTpass purchase failed: ${(err as Error).message}`);
      return {
        status: 'failed',
        providerReference: params.requestId,
        message: (err as Error).message,
      };
    }
  }

  async requery(providerReference: string): Promise<VtuPurchaseResult> {
    try {
      const res = await firstValueFrom(
        this.http.post(
          `${this.baseUrl}/requery`,
          { request_id: providerReference },
          { headers: this.postHeaders() },
        ),
      );
      return this.mapResponse(res.data, providerReference);
    } catch (err) {
      this.logger.error(`VTpass requery failed: ${(err as Error).message}`);
      // A network/HTTP failure on the STATUS CHECK itself doesn't mean the
      // purchase failed — it means we don't know yet. Reporting "pending"
      // here (rather than "failed") avoids BillsService.checkStatus
      // reversing a debit for a purchase that may well have gone through;
      // the caller just tries the requery again later.
      return { status: 'pending', providerReference, message: (err as Error).message };
    }
  }

  private mapResponse(data: any, fallbackReference: string): VtuPurchaseResult {
    // content.transactions.status ("delivered" | "pending" | "failed" |
    // "reversed" | "refunded") is VTpass's most reliable signal and is
    // checked first; the coarser top-level `code` ("000" success, "016"
    // pending/processing, anything else an error) is the fallback for
    // responses that don't carry a transactions object at all (e.g. a hard
    // validation error VTpass rejects before attempting the purchase).
    const txnStatus: string | undefined = data?.content?.transactions?.status;
    let status: 'success' | 'pending' | 'failed';
    if (txnStatus) {
      status = txnStatus === 'delivered' ? 'success' : txnStatus === 'pending' ? 'pending' : 'failed';
    } else {
      const code = data?.code;
      status = code === '000' ? 'success' : code === '016' ? 'pending' : 'failed';
    }
    return {
      status,
      providerReference: data?.requestId ?? data?.request_id ?? fallbackReference,
      message: data?.response_description,
      pin:
        data?.content?.transactions?.purchased_code ??
        data?.purchased_code ??
        data?.content?.transactions?.token ??
        data?.token,
    };
  }
}
