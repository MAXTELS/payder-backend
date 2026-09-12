import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { VtpassProvider } from '../bills/providers/vtpass.provider';
import { BuyExamPinDto } from './dto/buy-exam-pin.dto';

// PAYDER's flat margin on every WAEC/NECO pin — added on top of the real
// provider/config price and baked into the single total the customer sees
// and pays. It is never shown as its own line item and the customer has no
// way to change it; VTpass's own purchase call (see buyExamPin below) only
// ever receives the real, non-marked-up price, so this ₦1,000 is exactly
// what PAYDER keeps per pin.
const EXAM_PIN_MARKUP = 1000;

// WAEC's real serviceID is "waec" (confirmed against
// vtpass.com/documentation/waec-result-checker-api/) — this used to be
// wired to "waec-registration", a *different* VTpass product (WAEC
// candidate registration, not result-checker pins), which is why WAEC pin
// purchases never worked correctly. JAMB's serviceID ("jamb") was already
// correct.
const EXAM_TYPE_TO_SERVICE_ID = {
  waec: 'waec',
  jamb: 'jamb',
} as const;

// NECO does not sell result-checker pins through VTpass, and no other
// aggregator is wired into this app (confirmed against
// vtpass.com/documentation/, 2026-09 — see also vtpass.provider.ts's header
// comment). Rather than hide NECO entirely or fail every purchase, NECO
// pins are fulfilled MANUALLY: the customer is debited immediately (real
// price + the same markup as WAEC), the transaction is left PROCESSING with
// a note that PAYDER is sourcing the pin, and staff buy the actual pin from
// NECO's own portal and attach it via AdminService.fulfillExamPin — the
// same "debit now, admin completes it" shape as the Remita/eTranzact manual
// payment flow. Update this constant if NECO's real price changes; there is
// no live API to source it from.
const NECO_REAL_PRICE = 900;

/**
 * Exam e-pin sales (WAEC result-checker, NECO result-checker, JAMB e-PIN).
 * Deliberately scoped down from "register for JAMB/Post-UTME" to "sell the
 * e-pin the candidate needs" — actual UTME/DE registration requires the
 * candidate to appear in person at a JAMB-accredited CBT centre and cannot
 * be done via API. See architecture doc §5.5 for the full explanation.
 *
 * WAEC and NECO are priced ENTIRELY server-side (see getPricing) — the
 * customer is never able to type or influence the amount for those two,
 * closing off what used to be a real "customer types their own price" gap
 * in the old /exams page. JAMB is not yet wired into that pricing flow and
 * still trusts the client-supplied amount, same as the original scaffold.
 */
@Injectable()
export class ExamsService {
  constructor(
    private prisma: PrismaService,
    private wallet: WalletService,
    private vtpass: VtpassProvider,
  ) {}

  /**
   * The price a customer would be charged for a given exam type right now —
   * used both by the "pricing preview" the frontend shows before purchase
   * and internally by buyExamPin so the two can never drift apart.
   */
  async getPricing(examType: 'waec' | 'neco' | 'jamb') {
    if (examType === 'jamb') {
      // Not yet wired into backend-derived pricing — the client still picks
      // an amount for this one (unchanged from the original scaffold).
      return { examType, realPrice: null, markup: '0.00', totalPrice: null, variationCode: null };
    }

    let realPrice: number;
    let variationCode: string | undefined;

    if (examType === 'waec') {
      const variations = await this.vtpass.getVariations(EXAM_TYPE_TO_SERVICE_ID.waec);
      if (variations.length === 0) {
        throw new BadRequestException('WAEC pin pricing is unavailable right now — try again shortly.');
      }
      // VTpass's WAEC catalogue normally carries exactly one result-checker
      // variation; if it ever lists more, the cheapest is the canonical
      // "WAEC pin" this app sells (PAYDER only sells the basic result
      // checker, not registration — see architecture doc §5.5).
      const cheapest = [...variations].sort((a, b) => Number(a.amount) - Number(b.amount))[0];
      realPrice = Number(cheapest.amount);
      variationCode = cheapest.code;
    } else {
      realPrice = NECO_REAL_PRICE;
    }

    return {
      examType,
      realPrice: realPrice.toFixed(2),
      markup: EXAM_PIN_MARKUP.toFixed(2),
      totalPrice: (realPrice + EXAM_PIN_MARKUP).toFixed(2),
      variationCode: variationCode ?? null,
    };
  }

  async buyExamPin(userId: string, dto: BuyExamPinDto, idempotencyKey: string) {
    if (dto.examType === 'jamb') {
      return this.buyJambPin(userId, dto, idempotencyKey);
    }

    // waec / neco: the backend is the ONLY source of the amount — dto.amount
    // is ignored entirely (it isn't even accepted by the DTO for these two)
    // so there is no way for a client to influence what gets debited.
    const pricing = await this.getPricing(dto.examType);
    const realPrice = Number(pricing.realPrice);
    const totalCharge = pricing.totalPrice!;

    const transaction = await this.wallet.debitWalletForPurchase({
      userId,
      amount: totalCharge,
      type: 'EXAM_PIN',
      idempotencyKey,
      metadata: {
        examType: dto.examType,
        realPrice: realPrice.toFixed(2),
        markup: EXAM_PIN_MARKUP.toFixed(2),
      },
    });

    // Already processed (idempotent replay) — normalize the same shape a
    // fresh purchase below would return, rather than the raw stored row.
    if (transaction.status !== 'PENDING') {
      const meta = (transaction.metadata as Record<string, unknown> | null) ?? {};
      return {
        transactionId: transaction.id,
        status: transaction.status,
        pin: (meta.pin as string | null) ?? null,
      };
    }

    if (dto.examType === 'neco') {
      // No live aggregator — leave this PROCESSING for manual fulfillment
      // (see AdminService.fulfillExamPin) rather than pretending to call a
      // provider that doesn't sell NECO pins.
      const updated = await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'PROCESSING',
          metadata: {
            ...(transaction.metadata as object),
            fulfillment: 'manual',
            note: 'Your NECO pin is being sourced by our team and will appear here shortly.',
          },
        },
      });
      return { transactionId: updated.id, status: updated.status, pin: null };
    }

    // waec — real VTpass purchase, using ONLY the real price. VTpass itself
    // ignores the `amount` field for variation-priced services (the
    // variation_code determines the charge), but this is passed as the real
    // price anyway for clarity/logging — never the marked-up total the
    // customer was actually charged.
    const result = await this.vtpass.purchase({
      requestId: transaction.id,
      serviceId: EXAM_TYPE_TO_SERVICE_ID.waec,
      variationCode: pricing.variationCode ?? undefined,
      customerId: dto.phone,
      amount: realPrice,
      phone: dto.phone,
    });

    if (result.status === 'failed') {
      const reversed = await this.wallet.reversePendingDebit(
        transaction.id,
        result.message ?? 'Exam pin purchase failed',
      );
      return { transactionId: reversed.id, status: reversed.status, pin: null };
    }

    const status = result.status === 'success' ? 'SUCCESS' : 'PROCESSING';
    const updated = await this.prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        status,
        providerReference: result.providerReference,
        completedAt: status === 'SUCCESS' ? new Date() : undefined,
        metadata: {
          ...(transaction.metadata as object),
          providerMessage: result.message,
          pin: result.pin ?? null,
        },
      },
    });
    return { transactionId: updated.id, status: updated.status, pin: result.pin ?? null };
  }

  /** Unchanged from the original scaffold — see class header comment. */
  private async buyJambPin(userId: string, dto: BuyExamPinDto, idempotencyKey: string) {
    if (!dto.amount) {
      throw new BadRequestException('amount is required for JAMB pins');
    }

    const transaction = await this.wallet.debitWalletForPurchase({
      userId,
      amount: dto.amount,
      type: 'EXAM_PIN',
      idempotencyKey,
      metadata: { examType: 'jamb' },
    });

    if (transaction.status !== 'PENDING') return transaction;

    const result = await this.vtpass.purchase({
      requestId: transaction.id,
      serviceId: EXAM_TYPE_TO_SERVICE_ID.jamb,
      customerId: dto.phone,
      amount: dto.amount,
      phone: dto.phone,
    });

    return { transactionId: transaction.id, pin: result.pin, status: result.status };
  }
}
