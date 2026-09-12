import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { createHash } from 'crypto';

/**
 * Generates throwaway RRRs so the "Pay a Remita invoice" screen can be
 * tested end-to-end without needing a real biller (a school, a church, a
 * government MDA) to hand you one first.
 *
 * This deliberately talks to a DIFFERENT Remita API than RemitaProvider
 * (remita.provider.ts): that one is Remita's Biller/Aggregator API — it
 * looks up and pays an RRR someone else already generated, authenticating
 * with a plain `secretKey` header against api-demo.systemspecsng.com. This
 * one is Remita's Merchant Collections "Payment Init" API — it CREATES a
 * new RRR, authenticates with a merchantId/serviceTypeId/apiKey trio hashed
 * with SHA-512, and lives on a separate host (demo.remita.net). They are
 * genuinely different Remita products, not two views of the same thing.
 *
 * Defaults to Remita's own PUBLICLY PUBLISHED demo credentials — merchantId
 * 2547916, serviceTypeId 4430731, apiKey 1946 — the exact trio Remita uses
 * in its own sample integrations and every public tutorial. These are not
 * a real merchant's secret, so it's safe to ship as a default; override via
 * REMITA_DEMO_MERCHANT_ID / REMITA_DEMO_SERVICE_TYPE_ID /
 * REMITA_DEMO_API_KEY / REMITA_DEMO_BASE_URL if PAYDER is ever issued its
 * own Remita sandbox merchant account.
 *
 * CAVEAT (tell the admin this, don't just silently hope it works): because
 * this hits a different Remita product than RemitaProvider.lookupRRR does,
 * an RRR generated here is not guaranteed to be found by that lookup —
 * Remita's sandbox environments aren't always shared across product lines
 * for a given account. It's still useful to confirm the RRR-entry screen's
 * UI/preview renders correctly; if the live "Check RRR" call can't find a
 * pin generated here, that means Remita's two sandboxes aren't linked for
 * this account, and their developer support would need to align them (or
 * PAYDER needs its own demo merchant account on the Biller API side too).
 */
@Injectable()
export class RemitaDemoProvider {
  private readonly logger = new Logger(RemitaDemoProvider.name);

  constructor(
    private http: HttpService,
    private config: ConfigService,
  ) {}

  private get baseUrl() {
    return this.config.get<string>('REMITA_DEMO_BASE_URL') ?? 'https://demo.remita.net';
  }
  private get merchantId() {
    return this.config.get<string>('REMITA_DEMO_MERCHANT_ID') ?? '2547916';
  }
  private get serviceTypeId() {
    return this.config.get<string>('REMITA_DEMO_SERVICE_TYPE_ID') ?? '4430731';
  }
  private get apiKey() {
    return this.config.get<string>('REMITA_DEMO_API_KEY') ?? '1946';
  }

  async generateDemoRrr(params: {
    amount: number;
    payerName?: string;
    payerEmail?: string;
    payerPhone?: string;
    description?: string;
  }): Promise<{ rrr: string; orderId: string; amount: number }> {
    const orderId = `PAYDERTEST${Date.now()}`;
    const amount = params.amount.toFixed(2);
    // Remita's own docs: hash = SHA512(merchantId + serviceTypeId + orderId
    // + amount + apiKey), sent as
    // "remitaConsumerKey={merchantId},remitaConsumerToken={hash}".
    const hash = createHash('sha512')
      .update(`${this.merchantId}${this.serviceTypeId}${orderId}${amount}${this.apiKey}`)
      .digest('hex');

    let res;
    try {
      res = await firstValueFrom(
        this.http.post(
          `${this.baseUrl}/remita/exapp/api/v1/send/api/echannelsvc/merchant/api/paymentinit`,
          {
            serviceTypeId: this.serviceTypeId,
            amount,
            orderId,
            payerName: params.payerName ?? 'PAYDER Test Payer',
            payerEmail: params.payerEmail ?? 'test.payer@payder.example',
            payerPhone: params.payerPhone ?? '08000000000',
            description: params.description ?? 'PAYDER test invoice',
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `remitaConsumerKey=${this.merchantId},remitaConsumerToken=${hash}`,
            },
          },
        ),
      );
    } catch (err) {
      this.logger.error(`Remita demo RRR generation failed: ${(err as Error).message}`);
      throw new BadRequestException("Could not reach Remita's demo service to generate a test RRR.");
    }

    // Remita's paymentinit response sometimes arrives JSONP-wrapped
    // ("jsonp1234567({...})") even when Content-Type says JSON — strip a
    // wrapper if present before parsing, the same defensive handling
    // Remita's own sample integrations use.
    const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    const match = raw.match(/\((.*)\)/s);
    let body: any;
    try {
      body = JSON.parse(match ? match[1] : raw);
    } catch {
      this.logger.error(`Remita demo RRR response was not parseable JSON: ${raw.slice(0, 300)}`);
      throw new BadRequestException("Remita's demo service returned an unexpected response.");
    }

    if (!body?.RRR) {
      throw new BadRequestException(
        body?.status ? `Remita: ${body.status}` : 'Remita did not return an RRR.',
      );
    }

    return { rrr: String(body.RRR), orderId, amount: params.amount };
  }
}
