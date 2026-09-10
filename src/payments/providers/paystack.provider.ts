import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { createHmac } from 'crypto';
import { firstValueFrom } from 'rxjs';
import {
  InitializeFundingResult,
  PaymentProvider,
  WebhookVerificationResult,
} from './payment-provider.interface';

@Injectable()
export class PaystackProvider implements PaymentProvider {
  readonly name = 'paystack' as const;
  private readonly logger = new Logger(PaystackProvider.name);
  private readonly baseUrl = 'https://api.paystack.co';

  constructor(
    private http: HttpService,
    private config: ConfigService,
  ) {}

  private get secretKey() {
    return this.config.get<string>('PAYSTACK_SECRET_KEY');
  }

  private authHeaders() {
    return { Authorization: `Bearer ${this.secretKey}` };
  }

  async createDedicatedVirtualAccount(params: {
    userId: string;
    email: string;
    firstName: string;
    lastName: string;
  }): Promise<{ accountNumber: string; bankName: string }> {
    // Paystack requires a customer to exist before a DVA can be assigned to
    // them. Two calls: create/fetch customer, then create the DVA.
    // https://paystack.com/docs/payments/dedicated-virtual-accounts/
    const customerRes = await firstValueFrom(
      this.http.post(
        `${this.baseUrl}/customer`,
        { email: params.email, first_name: params.firstName, last_name: params.lastName },
        { headers: this.authHeaders() },
      ),
    );
    const customerCode = customerRes.data?.data?.customer_code;

    const dvaRes = await firstValueFrom(
      this.http.post(
        `${this.baseUrl}/dedicated_account`,
        { customer: customerCode, preferred_bank: 'wema-bank' },
        { headers: this.authHeaders() },
      ),
    );

    const account = dvaRes.data?.data;
    return {
      accountNumber: account?.account_number,
      bankName: account?.bank?.name,
    };
  }

  async initializeCardCharge(params: {
    userId: string;
    email: string;
    amount: string;
    reference: string;
  }): Promise<InitializeFundingResult> {
    // `metadata.userId` MUST be sent — handlePaystackWebhook() reads
    // payload.data.metadata.userId to know which wallet to credit and
    // silently no-ops without it. `callback_url` sends the customer back to
    // the frontend (not this API) once checkout finishes, landing on the
    // page that calls the verify-on-return endpoint below.
    const webAppUrl = this.config.get<string>('WEB_APP_URL') ?? 'http://localhost:3001';
    const res = await firstValueFrom(
      this.http.post(
        `${this.baseUrl}/transaction/initialize`,
        {
          email: params.email,
          amount: Math.round(Number(params.amount) * 100), // kobo
          reference: params.reference,
          metadata: { userId: params.userId },
          callback_url: `${webAppUrl}/wallet/paystack-callback`,
        },
        { headers: this.authHeaders() },
      ),
    );
    return {
      authorizationUrl: res.data?.data?.authorization_url,
      reference: params.reference,
    };
  }

  /**
   * Calls Paystack's own verify-transaction API directly, rather than
   * waiting on a webhook. Paystack (a real internet service) can't reach a
   * developer's localhost, so in local dev the webhook never fires — this is
   * what lets "verify on return" (the customer landing back on
   * /wallet/paystack-callback after checkout) confirm and credit the wallet
   * instead. Safe to call in production too: PaymentsService reuses the same
   * `paystack:${reference}` idempotency key as the webhook path, so whichever
   * of the two fires first wins and the other is a no-op.
   */
  async verifyTransaction(reference: string): Promise<{
    status: 'success' | 'failed' | 'abandoned' | 'pending';
    amount?: string;
    userId?: string;
    currency?: string;
  }> {
    const res = await firstValueFrom(
      this.http.get(`${this.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: this.authHeaders(),
      }),
    );
    const data = res.data?.data;
    return {
      status: data?.status === 'success' ? 'success' : (data?.status ?? 'failed'),
      amount: data?.amount ? String(data.amount / 100) : undefined,
      userId: data?.metadata?.userId,
      currency: data?.currency,
    };
  }

  verifyWebhookSignature(
    signatureHeader: string | undefined,
    rawBody: Buffer | string,
  ): WebhookVerificationResult {
    if (!signatureHeader) return { isValid: false };
    const expected = createHmac('sha512', this.secretKey ?? '')
      .update(rawBody)
      .digest('hex');
    const isValid = expected === signatureHeader;
    if (!isValid) {
      this.logger.warn('Paystack webhook signature mismatch');
      return { isValid: false };
    }
    const payload = JSON.parse(rawBody.toString());
    return {
      isValid: true,
      event: payload.event,
      reference: payload.data?.reference,
      amount: payload.data?.amount ? String(payload.data.amount / 100) : undefined,
      currency: payload.data?.currency,
      raw: payload,
    };
  }
}
