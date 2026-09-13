import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export type PairgateExamType = 'waec' | 'neco';

export interface EducationPurchaseResult {
  status: 'pending' | 'failed';
  providerReference: string;
  message?: string;
  // Pairgate's own real charge for ONE pin, read straight off this
  // purchase's response — ExamsService uses this to self-heal its cached
  // "what does a pin actually cost right now" price (see
  // exams.service.ts's getOrCreateExamProduct), since Pairgate has no
  // separate pricing/quote endpoint for education (confirmed against
  // pairgate.com/developers/education-purchase — the ONLY place the real
  // price is ever exposed is inside an actual purchase's own response).
  unitPrice?: number;
}

export interface EducationStatusResult {
  status: 'success' | 'pending' | 'failed';
  pin?: string;
  message?: string;
}

/**
 * Pairgate education (WAEC/NECO/NABTEB) exam-pin purchase — a THIRD,
 * self-contained Pairgate-backed provider class alongside
 * betting/providers/pairgate.provider.ts and
 * bills/providers/pairgate-vtu.provider.ts. Deliberately its own class
 * rather than shoehorned into either of those: education's request/response
 * shape (quantity-based, per-pin `details[]` array, no phone/customerId/
 * amount fields at all) doesn't fit VtuProvider or BettingProvider's
 * interfaces, and — per this project's established pattern (see e.g.
 * vtpass.provider.ts staying registered-but-unused after the Pairgate VTU
 * swap) — keeping each integration isolated means a bug or a future
 * provider swap in one never risks the other two.
 *
 * Confirmed against pairgate.com/developers/education-providers and
 * .../education-purchase on 2026-09-13 (see project doc
 * claude/pairgate-api-full-reference.md for the full research):
 *
 *   GET  /providers/education                 -> {id, name, slug} per exam
 *                                                 body — "waec", "neco",
 *                                                 "nabt" all confirmed
 *                                                 present (this app only
 *                                                 offers the first two).
 *   POST /education/purchase  { provider_id, quantity, reference }
 *        -> { status, message, reference, total_amount, unit_price,
 *              quantity, exam_type, details: [{ reference, pin }] }
 *        `pin` is ALWAYS null in this synchronous response — the actual pin
 *        is delivered later via the Pairgate webhook (backend/src/webhooks/
 *        pairgate-webhook.*) or a /transaction/status poll (requery below).
 *        `unit_price`/`total_amount` ARE present synchronously, though —
 *        that's the one and only source of a real WAEC/NECO price (see
 *        EducationPurchaseResult.unitPrice's comment).
 *   GET  /transaction/status?reference_code=... — same generic endpoint
 *        every other Pairgate category uses.
 *
 * OPEN ASSUMPTION (flag before fully trusting at scale — same spirit as the
 * provider-id/slug caveat in pairgate-vtu.provider.ts): the docs show
 * `details[].reference` as a PER-PIN value, never a top-level
 * `reference_code` the way every other category returns one. This class
 * uses `details[0].reference` as the value to store and later pass to
 * `/transaction/status`'s `reference_code` param — this needs a live smoke
 * test to confirm Pairgate actually accepts it there; if requery/webhook
 * correlation ever silently stops matching a transaction, this is the first
 * thing to check. This app always purchases quantity: 1 (buy-one-pin-at-a-
 * time — see ExamsService), so `details` is always a single-element array
 * in practice and this ambiguity never compounds across multiple pins.
 */
@Injectable()
export class PairgateEducationProvider {
  readonly name = 'pairgate-education';
  private readonly logger = new Logger(PairgateEducationProvider.name);

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

  async purchase(params: {
    requestId: string;
    examType: PairgateExamType;
  }): Promise<EducationPurchaseResult> {
    try {
      const res = await firstValueFrom(
        this.http.post(
          `${this.baseUrl}${this.path('/education/purchase')}`,
          { provider_id: params.examType, quantity: 1, reference: params.requestId },
          { headers: this.authHeaders() },
        ),
      );
      const inner = res.data?.data ?? {};

      // Sandbox test_mode — same shape quirk already found and fixed for
      // betting; education's /test/... path likely behaves the same way
      // (no real reference_code/pin to poll for), so it's handled
      // defensively here even though not yet observed directly.
      if (inner.test_mode === true) {
        return {
          status: 'pending',
          providerReference: params.requestId,
          message: inner.message ?? 'Test purchase accepted (sandbox — no balance deducted).',
          unitPrice: inner.unit_price !== undefined ? Number(inner.unit_price) : undefined,
        };
      }

      if (inner.status !== true) {
        return {
          status: 'failed',
          providerReference: params.requestId,
          message: inner.message ?? 'Education pin purchase was declined.',
        };
      }

      const detail = Array.isArray(inner.details) ? inner.details[0] : undefined;
      return {
        status: 'pending', // pin is always null synchronously — see class header comment
        providerReference: detail?.reference ?? params.requestId,
        message: inner.message,
        unitPrice: inner.unit_price !== undefined ? Number(inner.unit_price) : undefined,
      };
    } catch (err: any) {
      const detail = err?.response?.data ?? err?.message ?? err;
      this.logger.error(`Pairgate education purchase(${params.examType}) failed: ${JSON.stringify(detail)}`);
      return {
        status: 'failed',
        providerReference: params.requestId,
        message: err?.response?.data?.message ?? (err as Error).message,
      };
    }
  }

  async requery(providerReference: string): Promise<EducationStatusResult> {
    try {
      const res = await firstValueFrom(
        this.http.get(`${this.baseUrl}${this.path('/transaction/status')}`, {
          params: { reference_code: providerReference },
          headers: { ...this.authHeaders(), 'Cache-Control': 'no-cache' },
        }),
      );
      const inner = res.data?.data ?? {};
      const rawStr = (inner.status ?? '').toString().toLowerCase();
      const status: 'success' | 'pending' | 'failed' =
        rawStr === 'success' || rawStr === 'successful' || rawStr === 'completed'
          ? 'success'
          : rawStr === 'pending' || rawStr === 'processing'
            ? 'pending'
            : 'failed';
      // Same field-naming inconsistency as electricity purchase responses —
      // the pin may come back nested under `item` rather than as a bare
      // `pin` field; check both rather than assume one.
      const pin: string | undefined = inner.pin ?? inner.item?.pin ?? undefined;
      return { status, pin, message: inner.message };
    } catch (err: any) {
      const detail = err?.response?.data ?? err?.message ?? err;
      this.logger.error(`Pairgate education requery failed: ${JSON.stringify(detail)}`);
      return { status: 'pending', message: (err as Error).message };
    }
  }
}
