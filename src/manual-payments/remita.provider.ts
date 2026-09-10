import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';

export interface RemitaLookupResult {
  rrr: string;
  billerName: string;
  productName: string;
  payerName: string;
  phoneNumber: string;
  email: string;
  /** Principal + Remita's own processing fee — what actually gets collected
   *  from the payer (see Remita's "Process Bill" docs: "amount ... The total
   *  transaction amount ie the Principal plus Remita Fees"). */
  amount: number;
  /** Remita's cut, already included inside `amount` above. */
  remitaFee: number;
  /** The invoice principal only — what the biller (school, church, etc.)
   *  actually receives net of Remita's fee. */
  rrrAmount: number;
  currency: string;
  description: string;
  /** Remita's own status string for this RRR, lowercased (e.g. "pending",
   *  "processing"). Remita's docs don't enumerate every terminal value, so
   *  callers should match loosely (see ManualPaymentsService's
   *  isRemitaSuccessStatus/isRemitaFailureStatus) rather than exact-compare. */
  rrrStatus: string;
}

export interface RemitaProcessResult {
  rrr: string;
  paymentIdentifier: string;
  /** Commonly "PROCESSING" — settlement is async; poll lookupRRR (Remita's
   *  docs reuse the same endpoint as "Query Transaction") until it resolves. */
  transactionStatus: string;
}

/**
 * Talks to Remita's Biller API ("Lookup RRR" / "Process Transaction") so a
 * customer can pay an existing Remita invoice (school fees, church dues,
 * government MDA bills, etc.) straight from their PAYDER wallet, instead of
 * the interim admin-mediated flow in ManualPaymentsService. Endpoint shapes
 * below are taken directly from Remita's own published docs at
 * https://api.remita.net/ (Collections > Process Bill), confirmed against
 * this PAYDER account's real test credentials — not guessed.
 */
@Injectable()
export class RemitaProvider {
  private readonly logger = new Logger(RemitaProvider.name);

  constructor(
    private http: HttpService,
    private config: ConfigService,
  ) {}

  private get baseUrl() {
    return this.config.get<string>('REMITA_BASE_URL') ?? 'https://api-demo.systemspecsng.com';
  }

  private get secretKey() {
    return this.config.get<string>('REMITA_SECRET_KEY');
  }

  private headers() {
    // Remita's Biller API authenticates with a plain `secretKey` header —
    // no HMAC/signature, no Bearer token, per their own published examples.
    return { secretKey: this.secretKey ?? '' };
  }

  private handleError(err: unknown, fallback: string): never {
    const axiosErr = err as AxiosError<{ message?: string }>;
    const message = axiosErr?.response?.data?.message ?? fallback;
    this.logger.warn(`Remita API error: ${message}`);
    throw new BadRequestException(message);
  }

  /**
   * Remita's own portal commonly displays an RRR grouped for readability
   * (e.g. "1234-5678-9012") even though the underlying reference is purely
   * numeric (see the docs' own examples) — strip anything but digits so a
   * copy-pasted or hand-typed dashed/spaced value doesn't get sent to
   * Remita's API verbatim and come back as a generic API-level error
   * ("System malfunction" / "Error processing request") that looks like a
   * PAYDER bug rather than what it actually is: a malformed reference.
   * Applied here (not just in the frontend) so it holds regardless of caller.
   */
  private sanitizeRrr(rrr: string): string {
    const digitsOnly = rrr.replace(/\D/g, '');
    if (!digitsOnly) {
      throw new BadRequestException("That doesn't look like a valid RRR — it should be numbers only.");
    }
    return digitsOnly;
  }

  /**
   * Looks up an already-generated RRR. Used both to preview a bill before
   * the customer confirms, and — reusing the same endpoint, per Remita's own
   * docs ("Query Transaction") — to poll for the updated status of one
   * already being processed.
   */
  async lookupRRR(rrr: string): Promise<RemitaLookupResult> {
    const cleanRrr = this.sanitizeRrr(rrr);
    let res;
    try {
      res = await firstValueFrom(
        this.http.get(
          `${this.baseUrl}/services/connect-gateway/api/v1/biller/lookup/${encodeURIComponent(cleanRrr)}`,
          { headers: this.headers() },
        ),
      );
    } catch (err) {
      this.handleError(err, 'Could not reach Remita to look up this RRR');
    }

    const body = res.data;
    if (body?.status !== '00') {
      throw new BadRequestException(
        body?.message || `That doesn't look like a valid or active Remita RRR.`,
      );
    }

    const data = body.data ?? {};
    return {
      rrr: data.rrr ?? cleanRrr,
      billerName: data.billerName ?? 'Unknown biller',
      productName: data.productName ?? '',
      payerName: data.name ?? '',
      phoneNumber: data.phoneNumber ?? '',
      email: data.email ?? '',
      amount: Number(data.amount ?? 0),
      remitaFee: Number(data.fee ?? 0),
      rrrAmount: Number(data.rrrAmount ?? data.amount ?? 0),
      currency: data.currency ?? 'NGN',
      description: data.description || data.productName || '',
      rrrStatus: String(data.status ?? '').toLowerCase(),
    };
  }

  /**
   * Settles an RRR with Remita. Per Remita's own docs: "Prior to sending
   * this request, it is expected that debit from the payer has been
   * secured" — callers MUST have already held/debited the customer's wallet
   * before calling this (see ManualPaymentsService.payRemitaBill).
   */
  async processBill(params: {
    rrr: string;
    paymentIdentifier: string;
    amount: number;
  }): Promise<RemitaProcessResult> {
    const cleanRrr = this.sanitizeRrr(params.rrr);
    let res;
    try {
      res = await firstValueFrom(
        this.http.post(
          `${this.baseUrl}/services/connect-gateway/api/v1/biller/process`,
          {
            rrr: cleanRrr,
            paymentIdentifier: params.paymentIdentifier,
            amount: params.amount,
          },
          { headers: this.headers() },
        ),
      );
    } catch (err) {
      this.handleError(err, 'Remita could not process this bill right now');
    }

    const body = res.data;
    if (body?.status !== '00') {
      throw new BadRequestException(body?.message || 'Remita rejected this payment.');
    }

    const data = body.data ?? {};
    return {
      rrr: data.rrr ?? cleanRrr,
      paymentIdentifier: data.paymentIdentifier ?? params.paymentIdentifier,
      transactionStatus: String(data.transactionStatus ?? '').toUpperCase(),
    };
  }
}
