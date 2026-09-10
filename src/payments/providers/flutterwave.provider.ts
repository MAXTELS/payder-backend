import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import {
  InitializeFundingResult,
  PaymentProvider,
  WebhookVerificationResult,
} from './payment-provider.interface';

@Injectable()
export class FlutterwaveProvider implements PaymentProvider {
  readonly name = 'flutterwave' as const;
  private readonly logger = new Logger(FlutterwaveProvider.name);
  private readonly baseUrl = 'https://api.flutterwave.com/v3';

  constructor(
    private http: HttpService,
    private config: ConfigService,
  ) {}

  private authHeaders() {
    return { Authorization: `Bearer ${this.config.get<string>('FLUTTERWAVE_SECRET_KEY')}` };
  }

  async createDedicatedVirtualAccount(params: {
    userId: string;
    email: string;
    firstName: string;
    lastName: string;
  }): Promise<{ accountNumber: string; bankName: string }> {
    const res = await firstValueFrom(
      this.http.post(
        `${this.baseUrl}/virtual-account-numbers`,
        {
          email: params.email,
          is_permanent: true,
          bvn: undefined, // supplied once KYC tier requires/allows it
          tx_ref: `payder-dva-${params.userId}`,
          firstname: params.firstName,
          lastname: params.lastName,
        },
        { headers: this.authHeaders() },
      ),
    );
    const data = res.data?.data;
    return { accountNumber: data?.account_number, bankName: data?.bank_name };
  }

  async initializeCardCharge(params: {
    userId: string;
    email: string;
    amount: string;
    reference: string;
  }): Promise<InitializeFundingResult> {
    const res = await firstValueFrom(
      this.http.post(
        `${this.baseUrl}/payments`,
        {
          tx_ref: params.reference,
          amount: params.amount,
          currency: 'NGN',
          customer: { email: params.email },
          redirect_url: `${this.config.get('APP_URL')}/payments/callback`,
        },
        { headers: this.authHeaders() },
      ),
    );
    return {
      authorizationUrl: res.data?.data?.link,
      reference: params.reference,
    };
  }

  verifyWebhookSignature(
    signatureHeader: string | undefined,
    rawBody: Buffer | string,
  ): WebhookVerificationResult {
    // Flutterwave uses a static verif-hash header comparison rather than an
    // HMAC of the body — simpler, but still must never be skipped.
    const expected = this.config.get<string>('FLUTTERWAVE_WEBHOOK_HASH');
    const isValid = !!signatureHeader && signatureHeader === expected;
    if (!isValid) {
      this.logger.warn('Flutterwave webhook hash mismatch');
      return { isValid: false };
    }
    const payload = JSON.parse(rawBody.toString());
    return {
      isValid: true,
      event: payload.event,
      reference: payload.data?.tx_ref,
      amount: payload.data?.amount ? String(payload.data.amount) : undefined,
      currency: payload.data?.currency,
      raw: payload,
    };
  }
}
