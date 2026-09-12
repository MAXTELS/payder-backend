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
    originHint?: string;
  }): Promise<InitializeFundingResult> {
    // `metadata.userId` MUST be sent — handlePaystackWebhook() reads
    // payload.data.metadata.userId to know which wallet to credit and
    // silently no-ops without it. `callback_url` sends the customer back to
    // the frontend (not this API) once checkout finishes, landing on the
    // page that calls the verify-on-return endpoint below.
    //
    // `originHint` (the initiating request's Origin header, threaded down
    // from the controller) wins over the static WEB_APP_URL env var when
    // present — this is what makes funding work from a phone on the LAN
    // without editing .env every time the PC's IP changes: the phone's
    // browser loaded the web app from e.g. http://192.168.1.5:3001, so its
    // own API calls carry that exact origin, and that's also exactly where
    // Paystack needs to redirect it back to. WEB_APP_URL remains the
    // fallback for server-to-server calls with no browser Origin header
    // (there aren't any today, but this keeps old behavior for anything that
    // doesn't send one) and becomes the real production domain once deployed.
    const webAppUrl =
      params.originHint || this.config.get<string>('WEB_APP_URL') || 'http://localhost:3001';
    const res = await firstValueFrom(
      this.http.post(
        `${this.baseUrl}/transaction/initialize`,
        {
          email: params.email,
          amount: Math.round(Number(params.amount) * 100), // kobo
          reference: params.reference,
          // `requestedAmount` is the naira figure the customer actually asked
          // to fund — Paystack echoes `metadata` back verbatim on both the
          // webhook and verify-transaction responses, so this is what
          // verifyTransaction/handlePaystackWebhook credit the wallet with,
          // instead of Paystack's own `data.amount`. Those can legitimately
          // differ: when the Paystack account has "customer bears the
          // transaction fee" enabled, Paystack's checkout silently inflates
          // the amount actually charged to the card (e.g. ₦500 requested →
          // ₦507.62 charged) so the merchant still nets the full ₦500 — that
          // inflated figure is what a card statement should show, but it is
          // NOT what the customer's wallet should be credited with.
          metadata: { userId: params.userId, requestedAmount: params.amount },
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
    // Prefer the amount the customer actually asked to fund (stashed in
    // metadata at initialize time) over Paystack's own `data.amount`, which
    // can be inflated by a passed-through transaction fee — see the comment
    // in initializeCardCharge.
    const requestedAmount = data?.metadata?.requestedAmount;
    return {
      status: data?.status === 'success' ? 'success' : (data?.status ?? 'failed'),
      amount: requestedAmount ?? (data?.amount ? String(data.amount / 100) : undefined),
      userId: data?.metadata?.userId,
      currency: data?.currency,
    };
  }

  /**
   * Generic (non-wallet-funding) Paystack checkout — added for the biller
   * bill-pay feature (guest/unauthenticated payment, and biller wallet
   * deposit). Deliberately NOT part of the shared `PaymentProvider`
   * interface: that contract is specifically "fund a customer's own wallet"
   * and is implemented identically by FlutterwaveProvider — bolting a
   * generic-charge method onto it would force a matching (and currently
   * unneeded) Flutterwave implementation. `metadata` is caller-defined and
   * returned as-is by verifyTransactionGeneric below, e.g.
   * `{ kind: 'biller_bill_payment', billerPaymentId }` or
   * `{ kind: 'biller_wallet_deposit', billerId }`.
   */
  async initializeGenericCharge(params: {
    email: string;
    amount: string | number;
    reference: string;
    metadata: Record<string, unknown>;
    callbackPath: string; // e.g. "/pay-bill/callback" — appended to WEB_APP_URL
    originHint?: string; // see initializeCardCharge's comment — same reasoning
  }): Promise<InitializeFundingResult> {
    const webAppUrl =
      params.originHint || this.config.get<string>('WEB_APP_URL') || 'http://localhost:3001';
    const res = await firstValueFrom(
      this.http.post(
        `${this.baseUrl}/transaction/initialize`,
        {
          email: params.email,
          amount: Math.round(Number(params.amount) * 100), // kobo
          reference: params.reference,
          // See initializeCardCharge's comment: stash the requested amount so
          // verifyTransactionGeneric can credit that instead of Paystack's
          // own (possibly fee-inflated) `data.amount`.
          metadata: { ...params.metadata, requestedAmount: String(params.amount) },
          callback_url: `${webAppUrl}${params.callbackPath}`,
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
   * Same idea as verifyTransaction, but returns the full `metadata` object
   * instead of assuming it only ever carries `userId` — the guest bill-pay
   * and biller-deposit flows both need their own custom metadata shape read
   * back on verification.
   */
  async verifyTransactionGeneric(reference: string): Promise<{
    status: 'success' | 'failed' | 'abandoned' | 'pending';
    amount?: string;
    email?: string;
    metadata?: Record<string, any>;
    currency?: string;
  }> {
    const res = await firstValueFrom(
      this.http.get(`${this.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: this.authHeaders(),
      }),
    );
    const data = res.data?.data;
    const requestedAmount = data?.metadata?.requestedAmount;
    return {
      status: data?.status === 'success' ? 'success' : (data?.status ?? 'failed'),
      amount: requestedAmount ?? (data?.amount ? String(data.amount / 100) : undefined),
      email: data?.customer?.email,
      metadata: data?.metadata,
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
    const requestedAmount = payload.data?.metadata?.requestedAmount;
    return {
      isValid: true,
      event: payload.event,
      reference: payload.data?.reference,
      amount: requestedAmount ?? (payload.data?.amount ? String(payload.data.amount / 100) : undefined),
      currency: payload.data?.currency,
      raw: payload,
    };
  }
}
