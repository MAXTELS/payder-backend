import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { EmailService } from '../common/email/email.service';
import { ReceiptService } from './receipt.service';
import { RemitaProvider } from './remita.provider';
import { RemitaDemoProvider } from './remita-demo.provider';
import { LookupManualPaymentDto } from './dto/lookup-manual-payment.dto';
import { CreateManualPaymentDto } from './dto/create-manual-payment.dto';
import { MarkPaidDto } from './dto/mark-paid.dto';
import { RejectManualPaymentDto } from './dto/reject-manual-payment.dto';
import { GenerateDemoRrrDto } from './dto/generate-demo-rrr.dto';

// Loose format checks only — there is no live Remita/eTranzact merchant
// account to look these up against yet (§5.3/§5.4). Remita RRRs are
// documented as numeric, commonly 12 digits; eTranzact has no public spec we
// could confirm, so it just gets a length/charset sanity check. Tightening
// these is a one-line change once real lookup access exists.
const REFERENCE_FORMATS: Record<'REMITA' | 'ETRANZACT', RegExp> = {
  REMITA: /^\d{10,15}$/,
  ETRANZACT: /^[A-Za-z0-9-]{4,30}$/,
};

const MANUAL_PAYMENT_SLA_HOURS = 24;

@Injectable()
export class ManualPaymentsService {
  private readonly logger = new Logger(ManualPaymentsService.name);

  constructor(
    private prisma: PrismaService,
    private wallet: WalletService,
    private email: EmailService,
    private receipts: ReceiptService,
    private remita: RemitaProvider,
    private remitaDemo: RemitaDemoProvider,
    private config: ConfigService,
  ) {}

  // Admin-only test helper — see RemitaDemoProvider's header comment for why
  // this hits a different Remita API than lookupRemitaBill/payRemitaBill
  // below, and the caveat about the generated RRR not being guaranteed to
  // show up through the Biller API those use.
  generateDemoRrr(dto: GenerateDemoRrrDto) {
    return this.remitaDemo.generateDemoRrr(dto);
  }

  /**
   * Step 1 of §5.4b: cross-check the reference format and hand back a
   * confirmation preview. No wallet debit happens here — nothing is
   * committed until the customer calls create() with the same details.
   */
  lookup(dto: LookupManualPaymentDto) {
    const pattern = REFERENCE_FORMATS[dto.biller];
    const formatValid = pattern.test(dto.invoiceReference.trim());

    if (!formatValid) {
      return {
        valid: false,
        message: `That doesn't look like a valid ${dto.biller} reference. Double-check the number and try again.`,
      };
    }

    return {
      valid: true,
      biller: dto.biller,
      invoiceReference: dto.invoiceReference.trim(),
      message:
        'Reference format looks valid. We could not automatically confirm the invoice amount ' +
        '(no direct biller connection yet) — enter the amount shown on your invoice to continue.',
    };
  }

  /**
   * Step 2 of §5.4b: customer confirms. Holds the funds (debit user, credit
   * suspense — same mechanism as any other purchase, see
   * WalletService.debitWalletForPurchase) and queues the request for an
   * admin.
   */
  async create(userId: string, dto: CreateManualPaymentDto) {
    const pattern = REFERENCE_FORMATS[dto.biller];
    if (!pattern.test(dto.invoiceReference.trim())) {
      throw new BadRequestException(`Invalid ${dto.biller} reference format`);
    }

    const idempotencyKey = `manual-payment:${userId}:${dto.biller}:${dto.invoiceReference}:${Date.now()}`;

    const heldTransaction = await this.wallet.debitWalletForPurchase({
      userId,
      amount: dto.amount,
      type: 'BILL_PAYMENT',
      idempotencyKey,
    });

    const slaDueAt = new Date(Date.now() + MANUAL_PAYMENT_SLA_HOURS * 60 * 60 * 1000);

    return this.prisma.manualPaymentRequest.create({
      data: {
        userId,
        biller: dto.biller,
        invoiceReference: dto.invoiceReference.trim(),
        payerName: dto.payerName,
        description: dto.description,
        amount: dto.amount,
        heldTransactionId: heldTransaction.id,
        slaDueAt,
      },
    });
  }

  listMine(userId: string) {
    return this.prisma.manualPaymentRequest.findMany({
      where: { userId },
      orderBy: { submittedAt: 'desc' },
    });
  }

  // Admin queue — oldest pending first, per §5.4b/§9.
  listQueue(status?: string) {
    return this.prisma.manualPaymentRequest.findMany({
      where: status ? { status: status as any } : undefined,
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
      orderBy: { submittedAt: 'asc' },
    });
  }

  async markPaid(id: string, adminId: string, dto: MarkPaidDto) {
    const request = await this.prisma.manualPaymentRequest.findUnique({
      where: { id },
      include: { user: true },
    });
    if (!request) throw new NotFoundException('Manual payment request not found');
    if (request.status !== 'PENDING') {
      throw new BadRequestException(`Request is already ${request.status.toLowerCase()}`);
    }
    if (request.biller === 'REMITA') {
      // Remita RRRs are now settled automatically (see payRemitaBill /
      // checkRemitaStatus below) — an admin marking one "paid" by hand would
      // generate a receipt without Remita ever having actually confirmed the
      // payment, and would leave the two systems out of sync. Direct the
      // admin at the real status instead of letting them override it.
      throw new BadRequestException(
        'This is a Remita RRR — it settles automatically. Use "Refresh status" instead of marking it paid manually.',
      );
    }

    await this.prisma.transaction.update({
      where: { id: request.heldTransactionId },
      data: { status: 'SUCCESS', completedAt: new Date(), providerReference: dto.providerConfirmationRef },
    });

    const resolvedAt = new Date();
    const updated = await this.prisma.manualPaymentRequest.update({
      where: { id },
      data: {
        status: 'PAID',
        assignedAdminId: adminId,
        providerConfirmationRef: dto.providerConfirmationRef,
        resolvedAt,
      },
    });

    const { buffer, relativePath } = await this.receipts.generateManualPaymentReceipt({
      ...updated,
      user: request.user,
    });

    const withReceipt = await this.prisma.manualPaymentRequest.update({
      where: { id },
      data: { receiptPdfUrl: relativePath },
    });

    await this.email.send({
      to: request.user.email,
      subject: `PAYDER receipt — ${request.biller} invoice ${request.invoiceReference}`,
      text:
        `Hi ${request.user.firstName},\n\nYour ${request.biller} invoice payment (reference ` +
        `${request.invoiceReference}) has been completed. Your receipt is attached.\n\nThank you for using PAYDER.`,
      attachments: [{ filename: `payder-receipt-${id}.pdf`, content: buffer }],
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actorRole: 'ADMIN',
        action: 'manual_payment.paid',
        targetEntity: 'ManualPaymentRequest',
        targetId: id,
        afterState: { status: 'PAID', providerConfirmationRef: dto.providerConfirmationRef },
      },
    });

    return withReceipt;
  }

  async reject(id: string, adminId: string, dto: RejectManualPaymentDto) {
    const request = await this.prisma.manualPaymentRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('Manual payment request not found');
    if (request.status !== 'PENDING') {
      throw new BadRequestException(`Request is already ${request.status.toLowerCase()}`);
    }
    if (request.biller === 'REMITA') {
      // Same reasoning as markPaid: Remita RRRs resolve themselves via
      // payRemitaBill/checkRemitaStatus (success OR failure). An admin
      // shouldn't be able to short-circuit that with a manual reject.
      throw new BadRequestException(
        'This is a Remita RRR — it resolves automatically. Use "Refresh status" instead of rejecting it manually.',
      );
    }

    await this.wallet.reversePendingDebit(request.heldTransactionId, dto.reason);

    const updated = await this.prisma.manualPaymentRequest.update({
      where: { id },
      data: {
        status: 'REJECTED',
        assignedAdminId: adminId,
        rejectionReason: dto.reason,
        resolvedAt: new Date(),
      },
      include: { user: true },
    });

    await this.email.send({
      to: updated.user.email,
      subject: `PAYDER — your ${request.biller} invoice payment could not be completed`,
      text:
        `Hi ${updated.user.firstName},\n\nWe could not complete your ${request.biller} invoice payment ` +
        `(reference ${request.invoiceReference}). Reason: ${dto.reason}\n\nThe amount has been refunded to your wallet.`,
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actorRole: 'ADMIN',
        action: 'manual_payment.rejected',
        targetEntity: 'ManualPaymentRequest',
        targetId: id,
        afterState: { status: 'REJECTED', reason: dto.reason },
      },
    });

    return updated;
  }

  async getReceiptFile(id: string, requestingUser: { id: string; role: string }) {
    const request = await this.prisma.manualPaymentRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('Manual payment request not found');

    const isOwner = request.userId === requestingUser.id;
    const isStaff = requestingUser.role === 'ADMIN' || requestingUser.role === 'CUSTOMER_CARE';
    if (!isOwner && !isStaff) {
      throw new ForbiddenException('Not authorized to view this receipt');
    }
    if (!request.receiptPdfUrl) {
      throw new NotFoundException('Receipt not generated yet');
    }

    return this.receipts.readReceiptFile(request.receiptPdfUrl);
  }

  // ---------------------------------------------------------------------
  // Remita — real Biller API integration (lookup → fee preview → pay →
  // auto-settle). Replaces the generic REFERENCE_FORMATS/create() flow
  // above for REMITA specifically; ETRANZACT still goes through that
  // interim admin-mediated path until it gets a real merchant API too.
  // ---------------------------------------------------------------------

  /**
   * PAYDER's own cut on top of what Remita collects. `rrrAmount` is the
   * invoice principal (net of Remita's own fee) — percent is applied to
   * that, per the user's chosen "flat + percentage" structure.
   *
   * 2026-09-13: confirmed at ₦400 + 0.6% (Jude reviewed the fee audit and
   * chose to keep this value — a prior pass had the code default drifted
   * to ₦100 + 1.2%, out of sync with what .env.example already documented;
   * this fixes the code default to match the intended/documented value so
   * the two can't disagree again). Cap: the TOTAL fee (flat + percentage
   * combined) never exceeds ₦1,500 even on a very large invoice.
   */
  private remitaPortalFee(rrrAmount: number): number {
    const flat = Number(this.config.get<string>('REMITA_PORTAL_FLAT_FEE') ?? '400');
    const percent = Number(this.config.get<string>('REMITA_PORTAL_PERCENT_FEE') ?? '0.6');
    const cap = Number(this.config.get<string>('REMITA_PORTAL_FEE_CAP') ?? '1500');
    const fee = flat + (rrrAmount * percent) / 100;
    return Math.min(Math.round(fee * 100) / 100, cap);
  }

  private isRemitaSuccessStatus(status: string): boolean {
    return /paid|success|completed|approved/i.test(status);
  }

  private isRemitaFailureStatus(status: string): boolean {
    return /fail|reject|declin|cancel|error/i.test(status);
  }

  /**
   * Step 1: customer enters an RRR and sees exactly what they'll pay
   * (Remita's own amount — which already includes Remita's fee — plus
   * PAYDER's portal fee) before committing to anything. No wallet debit.
   */
  async lookupRemitaBill(rrr: string) {
    const lookup = await this.remita.lookupRRR(rrr);
    const portalFee = this.remitaPortalFee(lookup.rrrAmount);

    return {
      rrr: lookup.rrr,
      billerName: lookup.billerName,
      productName: lookup.productName,
      payerName: lookup.payerName,
      description: lookup.description,
      currency: lookup.currency,
      invoiceAmount: lookup.rrrAmount,
      remitaFee: lookup.remitaFee,
      portalFee,
      totalToPay: lookup.amount + portalFee,
      rrrStatus: lookup.rrrStatus,
      alreadyPaid: this.isRemitaSuccessStatus(lookup.rrrStatus),
    };
  }

  /**
   * Step 2: customer confirms. Always re-looks-up the RRR from Remita
   * (never trusts a client-supplied amount for a money flow), debits the
   * wallet for the full total (Remita's amount + PAYDER's fee), THEN calls
   * Remita's Process Transaction endpoint — per Remita's own docs, "it is
   * expected that debit from the payer has been secured" before this call.
   * Settlement is usually async ("PROCESSING"), so this can return a
   * still-PENDING request for the customer to poll via checkRemitaStatus.
   */
  async payRemitaBill(userId: string, rrr: string) {
    const lookup = await this.remita.lookupRRR(rrr);
    if (this.isRemitaSuccessStatus(lookup.rrrStatus)) {
      throw new BadRequestException('This Remita invoice has already been paid.');
    }

    const existing = await this.prisma.manualPaymentRequest.findFirst({
      where: {
        biller: 'REMITA',
        invoiceReference: lookup.rrr,
        status: { in: ['PENDING', 'PAID'] },
      },
    });
    if (existing) {
      throw new BadRequestException(
        'A payment for this Remita RRR is already in progress or has already completed.',
      );
    }

    const portalFee = this.remitaPortalFee(lookup.rrrAmount);
    const totalToDebit = lookup.amount + portalFee;
    const paymentIdentifier = `remita-${uuidv4()}`;
    const idempotencyKey = `remita:${paymentIdentifier}`;

    const heldTransaction = await this.wallet.debitWalletForPurchase({
      userId,
      amount: totalToDebit,
      type: 'BILL_PAYMENT',
      idempotencyKey,
      fee: lookup.remitaFee + portalFee,
      metadata: {
        remita: {
          rrr: lookup.rrr,
          billerName: lookup.billerName,
          productName: lookup.productName,
          invoiceAmount: lookup.rrrAmount,
          remitaFee: lookup.remitaFee,
          portalFee,
          paymentIdentifier,
        },
      },
    });

    const request = await this.prisma.manualPaymentRequest.create({
      data: {
        userId,
        biller: 'REMITA',
        invoiceReference: lookup.rrr,
        payerName: lookup.payerName,
        description:
          `${lookup.billerName} — ${lookup.productName || lookup.description} ` +
          `(Remita fee ₦${lookup.remitaFee.toFixed(2)}, PAYDER fee ₦${portalFee.toFixed(2)})`,
        amount: totalToDebit,
        heldTransactionId: heldTransaction.id,
        providerConfirmationRef: paymentIdentifier,
      },
    });

    try {
      const result = await this.remita.processBill({
        rrr: lookup.rrr,
        paymentIdentifier,
        // Remita's Process Transaction expects the full amount it will
        // collect — principal plus its own fee — same figure as `amount`
        // from the lookup, NOT the rrrAmount-only principal.
        amount: lookup.amount,
      });

      if (this.isRemitaFailureStatus(result.transactionStatus)) {
        return await this.failRemitaBill(
          request.id,
          `Remita declined this payment (status: ${result.transactionStatus})`,
        );
      }
      if (this.isRemitaSuccessStatus(result.transactionStatus)) {
        return await this.completeRemitaBill(request.id, paymentIdentifier);
      }
      // Still processing (commonly "PROCESSING") — leave PENDING; the
      // customer/UI polls checkRemitaStatus until Remita resolves it.
      return request;
    } catch (err) {
      await this.failRemitaBill(
        request.id,
        err instanceof Error ? err.message : 'Remita could not process this payment',
      );
      throw err;
    }
  }

  /**
   * Polled by the customer's status screen (and usable by staff) while a
   * Remita payment is still PENDING — re-queries Remita directly rather
   * than trusting any locally-cached status, since settlement happens on
   * Remita's side, not ours.
   */
  async checkRemitaStatus(id: string, requestingUser: { id: string; role: string }) {
    const request = await this.prisma.manualPaymentRequest.findUnique({
      where: { id },
      include: { user: true },
    });
    if (!request) throw new NotFoundException('Manual payment request not found');
    if (request.biller !== 'REMITA') {
      throw new BadRequestException('This request is not a Remita payment');
    }

    const isOwner = request.userId === requestingUser.id;
    const isStaff = requestingUser.role === 'ADMIN' || requestingUser.role === 'CUSTOMER_CARE';
    if (!isOwner && !isStaff) {
      throw new ForbiddenException('Not authorized to view this request');
    }

    if (request.status !== 'PENDING') {
      return request; // already resolved — nothing to poll
    }

    const lookup = await this.remita.lookupRRR(request.invoiceReference);
    if (this.isRemitaSuccessStatus(lookup.rrrStatus)) {
      return this.completeRemitaBill(
        request.id,
        request.providerConfirmationRef ?? request.invoiceReference,
      );
    }
    if (this.isRemitaFailureStatus(lookup.rrrStatus)) {
      return this.failRemitaBill(request.id, `Remita reported this payment as "${lookup.rrrStatus}"`);
    }

    return request; // still processing
  }

  /**
   * Marks a Remita request PAID, generates and emails the receipt — the
   * automatic-settlement equivalent of markPaid() above. No AuditLog entry
   * (actorId is a required FK to a human User, and there's no admin here);
   * the Logger line plus this row's own fields are the audit trail instead.
   */
  private async completeRemitaBill(requestId: string, providerRef: string) {
    const request = await this.prisma.manualPaymentRequest.findUnique({
      where: { id: requestId },
      include: { user: true },
    });
    if (!request) throw new NotFoundException('Manual payment request not found');
    if (request.status !== 'PENDING') return request; // already resolved (race with another poll)

    await this.prisma.transaction.update({
      where: { id: request.heldTransactionId },
      data: { status: 'SUCCESS', completedAt: new Date(), providerReference: providerRef },
    });

    const updated = await this.prisma.manualPaymentRequest.update({
      where: { id: requestId },
      data: { status: 'PAID', providerConfirmationRef: providerRef, resolvedAt: new Date() },
    });

    const { buffer, relativePath } = await this.receipts.generateManualPaymentReceipt({
      ...updated,
      user: request.user,
    });

    const withReceipt = await this.prisma.manualPaymentRequest.update({
      where: { id: requestId },
      data: { receiptPdfUrl: relativePath },
    });

    await this.email.send({
      to: request.user.email,
      subject: `PAYDER receipt — Remita invoice ${request.invoiceReference}`,
      text:
        `Hi ${request.user.firstName},\n\nYour Remita invoice payment (reference ` +
        `${request.invoiceReference}) has been completed automatically. Your receipt is attached.` +
        `\n\nThank you for using PAYDER.`,
      attachments: [{ filename: `payder-receipt-${requestId}.pdf`, content: buffer }],
    });

    this.logger.log(`Remita payment ${requestId} (RRR ${request.invoiceReference}) completed automatically.`);

    return withReceipt;
  }

  /**
   * Reverses the held debit and marks a Remita request REJECTED — the
   * automatic-settlement equivalent of reject() above, triggered by Remita
   * itself reporting failure rather than an admin decision.
   */
  private async failRemitaBill(requestId: string, reason: string) {
    const request = await this.prisma.manualPaymentRequest.findUnique({
      where: { id: requestId },
      include: { user: true },
    });
    if (!request) throw new NotFoundException('Manual payment request not found');
    if (request.status !== 'PENDING') return request;

    await this.wallet.reversePendingDebit(request.heldTransactionId, reason);

    const updated = await this.prisma.manualPaymentRequest.update({
      where: { id: requestId },
      data: { status: 'REJECTED', rejectionReason: reason, resolvedAt: new Date() },
      include: { user: true },
    });

    await this.email.send({
      to: updated.user.email,
      subject: `PAYDER — your Remita invoice payment could not be completed`,
      text:
        `Hi ${updated.user.firstName},\n\nWe could not complete your Remita invoice payment ` +
        `(reference ${request.invoiceReference}). Reason: ${reason}\n\nThe amount has been refunded to your wallet.`,
    });

    this.logger.warn(`Remita payment ${requestId} (RRR ${request.invoiceReference}) failed: ${reason}`);

    return updated;
  }
}
