import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { VtpassProvider } from '../bills/providers/vtpass.provider';
import { PairgateEducationProvider, PairgateExamType } from './providers/pairgate-education.provider';
import { EmailService } from '../common/email/email.service';
import { renderEmailHtml, paragraphHtml, pinBoxHtml } from '../common/email/email-template';
import { verifyTransactionPin } from '../common/security/transaction-pin.util';
import { BuyExamPinDto } from './dto/buy-exam-pin.dto';

// 2026-09-13: WAEC and NECO reverted from live Pairgate fulfillment to
// FULLY MANUAL — Jude's explicit instruction. Pairgate is no longer called
// for either exam type at all (PairgateEducationProvider stays injected
// below purely as a rollback path, same convention as VtpassProvider being
// kept-but-unused elsewhere in this codebase). The admin sets ONE number
// per exam type — ProductCatalog.sellPrice — and that IS the full price the
// customer pays; there is no separate PAYDER markup added on top anymore,
// since there's no longer a live "real cost from the provider" to mark up
// (the admin's own figure is already inclusive of whatever margin they
// want — same reasoning the old pre-Pairgate NECO-only manual flow used).
// getPricing() below keeps returning the same {realPrice, markup,
// totalPrice} shape the web/mobile pricing-preview screens already consume
// so neither frontend needs to change — markup is just always '0.00' now
// and totalPrice === the admin's sellPrice.
const EXAM_PRODUCT_PROVIDER_NAME = 'pairgate-education';
const EXAM_DEFAULT_SEED_PRICE: Record<PairgateExamType, number> = {
  waec: 1000,
  neco: 900,
};

/**
 * Exam e-pin sales (WAEC result-checker, NECO result-checker, JAMB e-PIN).
 * Deliberately scoped down from "register for JAMB/Post-UTME" to "sell the
 * e-pin the candidate needs" — actual UTME/DE registration requires the
 * candidate to appear in person at a JAMB-accredited CBT centre and cannot
 * be done via API. See architecture doc §5.5 for the full explanation.
 *
 * WAEC and NECO are priced ENTIRELY server-side (see getPricing) — the
 * customer is never able to type or influence the amount for those two.
 * JAMB is not offered by Pairgate's education category at all (confirmed —
 * only waec/neco/nabt exist there) and stays on VTpass, untouched, still
 * trusting the client-supplied amount as it always has.
 *
 * 2026-09-13 (later same day): WAEC and NECO both moved BACK to fully
 * manual fulfillment — Jude's explicit instruction, superseding the
 * same-day Pairgate migration above. Buying a WAEC/NECO pin now debits the
 * wallet for whatever price the admin has set for that exam type, lands
 * PROCESSING with metadata.fulfillment: 'manual', and makes NO provider
 * call at all — an admin manually buys the real pin from WAEC's/NECO's own
 * portal and delivers it via the existing PATCH
 * /admin/exams/:transactionId/fulfill route (AdminService.fulfillExamPin,
 * already examType-agnostic — no changes needed there). Same shape the old
 * pre-Pairgate NECO-only manual flow used, now applied to both exam types.
 */
@Injectable()
export class ExamsService {
  constructor(
    private prisma: PrismaService,
    private wallet: WalletService,
    private vtpass: VtpassProvider,
    private pairgateEducation: PairgateEducationProvider,
    private email: EmailService,
  ) {}

  /** Emails the finished pin to the buyer — best-effort, mirrors the pattern
   * used for withdrawal/funding notifications (EmailService itself never
   * throws, so this can't turn a successful purchase into a failed one).
   * [deliveryEmail] is the address the customer typed on the exam-pins form
   * (pre-filled with, but editable from, their account email) — falls back
   * to the account email if that came back empty for any reason. */
  private async emailPin(userId: string, examType: string, pin: string, deliveryEmail?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, firstName: true },
    });
    if (!user) return;
    const to = deliveryEmail?.trim() || user.email;
    const examLabel = examType.toUpperCase();
    await this.email.send({
      to,
      subject: `PAYDER — your ${examLabel} pin`,
      text:
        `Hi ${user.firstName},\n\nYour ${examLabel} result-checker pin is ready:\n\n` +
        `${pin}\n\nYou can also find this any time in the app under Transaction history.\n\n` +
        `Thank you for using PAYDER.`,
      html: renderEmailHtml({
        heading: `Your ${examLabel} pin is ready`,
        bodyHtml:
          paragraphHtml(`Hi ${user.firstName},`) +
          paragraphHtml(`Your ${examLabel} result-checker pin is ready — here it is:`) +
          pinBoxHtml(pin) +
          paragraphHtml(
            'You can also find this any time in the app under <strong>Transaction history</strong>.',
          ) +
          paragraphHtml('Thank you for using PAYDER.'),
      }),
    });
  }

  /**
   * Finds (or, on first-ever call, creates) the ProductCatalog row holding
   * a given exam type's admin-set price. sellPrice IS the full customer
   * price now (fully manual — see this file's header comment); costPrice is
   * kept purely as an optional admin-facing note of what the pin actually
   * cost to buy from WAEC/NECO's own portal, for their own margin tracking,
   * and is never shown to or charged to the customer.
   */
  private async getOrCreateExamProduct(examType: PairgateExamType) {
    const provider = await this.prisma.provider.upsert({
      where: { name: EXAM_PRODUCT_PROVIDER_NAME },
      update: {},
      create: { name: EXAM_PRODUCT_PROVIDER_NAME, type: 'VTU', isActive: true, priority: 0 },
    });
    const variationCode = `${examType}-exam-pin`;
    return this.prisma.productCatalog.upsert({
      where: { providerId_variationCode: { providerId: provider.id, variationCode } },
      update: {},
      create: {
        providerId: provider.id,
        category: 'exam',
        variationCode,
        name: `${examType.toUpperCase()} result-checker pin`,
        costPrice: EXAM_DEFAULT_SEED_PRICE[examType],
        sellPrice: EXAM_DEFAULT_SEED_PRICE[examType],
        isActive: true,
      },
    });
  }

  /** Admin dashboard read: what an exam pin is currently cached at (and
   * costs PAYDER). Kept under the same "neco-price" naming/route the admin
   * dashboard already has wired up (examType now selects which one). */
  async getNecoPriceConfig(examType: PairgateExamType = 'neco') {
    const product = await this.getOrCreateExamProduct(examType);
    return {
      sellPrice: product.sellPrice.toFixed(2),
      costPrice: product.costPrice.toFixed(2),
    };
  }

  /** Admin dashboard write: force-sets an exam type's cached price — useful
   * to seed a real value immediately after deploying, rather than waiting
   * for the first live purchase to self-heal it. Takes effect on the very
   * next pricing lookup/purchase. */
  async setNecoPrice(sellPrice: number, costPrice?: number, examType: PairgateExamType = 'neco') {
    const product = await this.getOrCreateExamProduct(examType);
    const updated = await this.prisma.productCatalog.update({
      where: { id: product.id },
      data: {
        sellPrice,
        ...(costPrice !== undefined ? { costPrice } : {}),
      },
    });
    return { sellPrice: updated.sellPrice.toFixed(2), costPrice: updated.costPrice.toFixed(2) };
  }

  /**
   * The price a customer would be charged for a given exam type right now —
   * used both by the "pricing preview" the frontend shows before purchase
   * and internally by buyExamPin so the two can never drift apart.
   */
  async getPricing(examType: 'waec' | 'neco' | 'jamb') {
    if (examType === 'jamb') {
      // Not offered by Pairgate's education category at all — still VTpass,
      // and the client still picks an amount for this one (unchanged).
      return { examType, realPrice: null, markup: '0.00', totalPrice: null, variationCode: null };
    }

    // 2026-09-13: fully manual now — the admin's sellPrice IS the total
    // customer price, no separate markup added on top (see this file's
    // header comment). realPrice/markup are kept in the response shape
    // purely so the existing web/mobile pricing-preview screens (which read
    // totalPrice) need no changes; markup is now always zero.
    const product = await this.getOrCreateExamProduct(examType);
    const totalPrice = Number(product.sellPrice);

    return {
      examType,
      realPrice: totalPrice.toFixed(2),
      markup: '0.00',
      totalPrice: totalPrice.toFixed(2),
      variationCode: null,
    };
  }

  async buyExamPin(userId: string, dto: BuyExamPinDto, idempotencyKey: string) {
    // Checked once here (ahead of the jamb delegation just below) so both
    // exam-pin purchase paths require a transaction PIN — buyJambPin is
    // only ever reached through this method, never called directly.
    const pinCheckUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { transactionPinHash: true },
    });
    if (!pinCheckUser) throw new NotFoundException('User not found');
    await verifyTransactionPin(pinCheckUser, dto.pin);

    if (dto.examType === 'jamb') {
      return this.buyJambPin(userId, dto, idempotencyKey);
    }

    // waec / neco: the backend is the ONLY source of the amount — dto.amount
    // is ignored entirely (it isn't even accepted by the DTO for these two)
    // so there is no way for a client to influence what gets debited.
    // 2026-09-13: fully manual (see header comment) — no provider call at
    // all, the transaction just lands PROCESSING for an admin to fulfill.
    const examType = dto.examType as PairgateExamType;
    const pricing = await this.getPricing(examType);
    const totalCharge = pricing.totalPrice!;

    const transaction = await this.wallet.debitWalletForPurchase({
      userId,
      amount: totalCharge,
      type: 'EXAM_PIN',
      idempotencyKey,
      metadata: {
        examType: dto.examType,
        fulfillment: 'manual',
        note: `Your ${examType.toUpperCase()} pin will be delivered to your email shortly.`,
        // Carried through so a confirmation email defaults to whatever the
        // customer typed here.
        deliveryEmail: dto.email?.trim() || undefined,
        pin: null,
      },
    });

    // Already processed (idempotent replay) — normalize the same shape a
    // fresh purchase below would return, rather than the raw stored row.
    // Also covers the ordinary case: debitWalletForPurchase leaves a
    // brand-new debit at PENDING, and there's no provider call to advance
    // it further here, so the very next line always applies to a fresh
    // purchase too.
    if (transaction.status !== 'PENDING') {
      const meta = (transaction.metadata as Record<string, unknown> | null) ?? {};
      return {
        transactionId: transaction.id,
        status: transaction.status,
        pin: (meta.pin as string | null) ?? null,
      };
    }

    const updated = await this.prisma.transaction.update({
      where: { id: transaction.id },
      data: { status: 'PROCESSING' },
    });
    return { transactionId: updated.id, status: updated.status, pin: null };
  }

  /**
   * Polled by the client while a WAEC/NECO purchase sits PROCESSING waiting
   * on an admin to manually fulfill it (metadata.fulfillment === 'manual' —
   * see this file's header comment). There is no provider to requery
   * anymore, so this is now a plain read: it just returns the transaction
   * as-is, and the "pin ready" moment is entirely driven by
   * AdminService.fulfillExamPin flipping it to SUCCESS. Kept as a real
   * method (not removed) since the client still polls this same route while
   * waiting. JAMB purchases never reach PROCESSING via this path (VTpass's
   * purchase either fully succeeds or fails synchronously — see
   * buyJambPin), so this only ever has real work to do for waec/neco.
   */
  async checkStatus(userId: string, transactionId: string) {
    const transaction = await this.prisma.transaction.findFirst({
      where: { id: transactionId, userId },
    });
    if (!transaction) {
      throw new NotFoundException('Transaction not found');
    }
    return transaction;
  }

  /**
   * Called by the Pairgate webhook handler (backend/src/webhooks/
   * pairgate-webhook.service.ts) when a PROCESSING exam-pin purchase's pin
   * finally arrives asynchronously — the primary path, with checkStatus
   * above (client polling) as the reconciliation fallback. No-ops if
   * already resolved by whichever path got there first — same dedup
   * reasoning as BillsService.resolveWebhookSuccess.
   */
  async resolveWebhookSuccess(transactionId: string, pin: string, message?: string) {
    const transaction = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!transaction || transaction.status !== 'PROCESSING') return transaction;
    const meta = (transaction.metadata as Record<string, unknown> | null) ?? {};
    const updated = await this.prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        status: 'SUCCESS',
        completedAt: new Date(),
        metadata: { ...meta, providerMessage: message, pin },
      },
    });
    const examType = (meta.examType as string) ?? 'exam';
    const deliveryEmail = meta.deliveryEmail as string | undefined;
    await this.emailPin(transaction.userId, examType, pin, deliveryEmail);
    return updated;
  }

  /** Same "no customer-facing phone field" change as buyExamPin above — see
   * that method's comment. JAMB stays on VTpass (Pairgate's education
   * category doesn't offer it — confirmed against
   * pairgate.com/developers/education-providers), otherwise unchanged from
   * the original scaffold. */
  private async buyJambPin(userId: string, dto: BuyExamPinDto, idempotencyKey: string) {
    if (!dto.amount) {
      throw new BadRequestException('amount is required for JAMB pins');
    }

    const buyer = await this.prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
    if (!buyer) throw new NotFoundException('User not found');

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
      serviceId: 'jamb',
      customerId: buyer.phone,
      amount: dto.amount,
      phone: buyer.phone,
    });

    if (result.pin) {
      await this.emailPin(userId, 'jamb', result.pin, dto.email);
    }
    return { transactionId: transaction.id, pin: result.pin, status: result.status };
  }
}
