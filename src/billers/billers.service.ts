import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WithdrawalsService } from '../withdrawals/withdrawals.service';
import { SupportService } from '../support/support.service';
import { PaystackProvider } from '../payments/providers/paystack.provider';
import { BillerWalletService } from './biller-wallet.service';
import { SetBillerPinDto } from './dto/set-biller-pin.dto';
import { BillerWithdrawDto } from './dto/biller-withdraw.dto';
import { ApproveBillerWithdrawalDto } from './dto/approve-biller-withdrawal.dto';
import { UpsertBillDto } from './dto/upsert-bill.dto';
import { BillerDepositDto } from './dto/biller-deposit.dto';
import { SetReportPreferenceDto } from './dto/report-preference.dto';
import { RequestBillEditDto } from './dto/request-bill-edit.dto';
import {
  BillFieldDefinition,
  validateFieldsShape,
  validatePricingComplete,
} from './bill-pricing.util';
import { toCsv } from '../common/csv/to-csv';

/**
 * Biller-self side of the feature: whatever a logged-in BILLER-role user can
 * do for their own biller. Auth is just the normal login flow (a biller-role
 * User row, same table as everyone else) — nothing here issues its own
 * tokens. See biller-feature-spec.md for the joint-withdrawal design this
 * class implements.
 *
 * Phase 2/3 additions (2026-09-10): bill builder (get/upsert/publish/request
 * edit), wallet deposit via Paystack, per-user report-frequency preference,
 * and payment history (list/filter/CSV export/daily report). See
 * biller-feature-spec.md for the full design.
 */
@Injectable()
export class BillersService {
  constructor(
    private prisma: PrismaService,
    private withdrawals: WithdrawalsService,
    private billerWallet: BillerWalletService,
    private support: SupportService,
    private paystack: PaystackProvider,
  ) {}

  private async requireBillerUser(userId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== 'BILLER' || !user.billerId) {
      throw new ForbiddenException('Not a biller account');
    }
    return user;
  }

  private async verifyPin(user: User, pin: string) {
    if (!user.transactionPinHash) {
      throw new BadRequestException(
        'Set a transaction PIN first — POST /billers/pin — before withdrawing.',
      );
    }
    const ok = await bcrypt.compare(pin, user.transactionPinHash);
    if (!ok) throw new UnauthorizedException('Incorrect PIN');
  }

  async getMe(userId: string) {
    const user = await this.requireBillerUser(userId);
    const biller = await this.prisma.biller.findUniqueOrThrow({
      where: { id: user.billerId! },
      include: {
        users: { select: { id: true, firstName: true, lastName: true, email: true, billerLabel: true } },
      },
    });
    const coSigner = biller.users.find((u) => u.id !== userId) ?? null;

    return {
      biller: {
        id: biller.id,
        name: biller.name,
        type: biller.type,
        isJoint: biller.isJoint,
        isActive: biller.isActive,
      },
      myLabel: user.billerLabel,
      coSigner: biller.isJoint ? coSigner : null,
      pinSet: !!user.transactionPinHash,
    };
  }

  async setPin(userId: string, dto: SetBillerPinDto) {
    const user = await this.requireBillerUser(userId);

    if (user.transactionPinHash) {
      if (!dto.currentPin) {
        throw new BadRequestException('currentPin is required to change an existing PIN');
      }
      const ok = await bcrypt.compare(dto.currentPin, user.transactionPinHash);
      if (!ok) throw new UnauthorizedException('Current PIN is incorrect');
    }

    const transactionPinHash = await bcrypt.hash(dto.pin, 12);
    await this.prisma.user.update({ where: { id: userId }, data: { transactionPinHash } });
    return { updated: true };
  }

  async getBalance(userId: string) {
    const user = await this.requireBillerUser(userId);
    return this.billerWallet.getBalance(user.billerId!);
  }

  async getStatement(userId: string, opts: { limit: number; cursor?: string }) {
    const user = await this.requireBillerUser(userId);
    return this.billerWallet.getStatement(user.billerId!, opts);
  }

  /**
   * Single biller: withdraws immediately (same shape as a customer's own
   * withdrawal). Joint biller: the initiator's PIN here is their half of
   * consent — this only creates a BillerWithdrawalDraft, debits nothing, and
   * waits for the OTHER signer to approve (approveDraft below).
   */
  async initiateWithdrawal(userId: string, dto: BillerWithdrawDto) {
    const user = await this.requireBillerUser(userId);
    await this.verifyPin(user, dto.pin);

    const biller = await this.prisma.biller.findUniqueOrThrow({ where: { id: user.billerId! } });

    if (!biller.isJoint) {
      const request = await this.withdrawals.createForBiller({
        billerId: biller.id,
        initiatorUserId: userId,
        amount: dto.amount,
        bankName: dto.bankName,
        accountNumber: dto.accountNumber,
        confirmAccountNumber: dto.confirmAccountNumber,
        accountName: dto.accountName,
      });
      return { awaitingCoSignerApproval: false, withdrawalRequest: request };
    }

    if (dto.accountNumber !== dto.confirmAccountNumber) {
      throw new BadRequestException('Account number and confirmation do not match');
    }

    const draft = await this.prisma.billerWithdrawalDraft.create({
      data: {
        billerId: biller.id,
        amount: dto.amount,
        bankName: dto.bankName,
        accountNumber: dto.accountNumber,
        accountName: dto.accountName,
        initiatedByUserId: userId,
      },
    });
    return { awaitingCoSignerApproval: true, draft };
  }

  async listDrafts(userId: string) {
    const user = await this.requireBillerUser(userId);
    return this.prisma.billerWithdrawalDraft.findMany({
      where: { billerId: user.billerId!, status: 'AWAITING_APPROVAL' },
      include: {
        initiatedBy: { select: { firstName: true, lastName: true, billerLabel: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async approveDraft(userId: string, draftId: string, dto: ApproveBillerWithdrawalDto) {
    const user = await this.requireBillerUser(userId);
    const draft = await this.prisma.billerWithdrawalDraft.findUnique({ where: { id: draftId } });
    if (!draft || draft.billerId !== user.billerId) {
      throw new NotFoundException('Withdrawal draft not found');
    }
    if (draft.status !== 'AWAITING_APPROVAL') {
      throw new BadRequestException(`This draft is already ${draft.status.toLowerCase()}`);
    }
    if (draft.initiatedByUserId === userId) {
      throw new BadRequestException(
        'The other signer needs to approve this withdrawal — you already gave your consent when you initiated it.',
      );
    }
    await this.verifyPin(user, dto.pin);

    // Only NOW does money actually move — see BillerWithdrawalDraft's schema
    // comment. `initiatorUserId` here is the approver, per
    // WithdrawalRequest's "whoever caused the debit to actually happen"
    // convention.
    const withdrawalRequest = await this.withdrawals.createForBiller({
      billerId: draft.billerId,
      initiatorUserId: userId,
      amount: draft.amount.toString(),
      bankName: draft.bankName,
      accountNumber: draft.accountNumber,
      confirmAccountNumber: draft.accountNumber,
      accountName: draft.accountName,
    });

    return this.prisma.billerWithdrawalDraft.update({
      where: { id: draftId },
      data: {
        status: 'APPROVED',
        approvedByUserId: userId,
        resolvedAt: new Date(),
        resultingWithdrawalRequestId: withdrawalRequest.id,
      },
    });
  }

  async cancelDraft(userId: string, draftId: string) {
    const user = await this.requireBillerUser(userId);
    const draft = await this.prisma.billerWithdrawalDraft.findUnique({ where: { id: draftId } });
    if (!draft || draft.billerId !== user.billerId) {
      throw new NotFoundException('Withdrawal draft not found');
    }
    if (draft.status !== 'AWAITING_APPROVAL') {
      throw new BadRequestException(`This draft is already ${draft.status.toLowerCase()}`);
    }

    return this.prisma.billerWithdrawalDraft.update({
      where: { id: draftId },
      data: { status: 'CANCELLED', resolvedAt: new Date() },
    });
  }

  async listWithdrawals(userId: string) {
    const user = await this.requireBillerUser(userId);
    return this.withdrawals.listMineForBiller(user.billerId!);
  }

  // ---------------------------------------------------------------------
  // Bill builder — each biller processes exactly one bill (BillDefinition.
  // billerId is @unique). DRAFT is freely editable; PUBLISHED is locked
  // unless oneTimeEditUnlockedAt is set by an admin (see requestBillEdit +
  // BillersAdminService.grantBillEdit).
  // ---------------------------------------------------------------------

  async getBill(userId: string) {
    const user = await this.requireBillerUser(userId);
    return this.prisma.billDefinition.findUnique({ where: { billerId: user.billerId! } });
  }

  async upsertBill(userId: string, dto: UpsertBillDto) {
    const user = await this.requireBillerUser(userId);
    validateFieldsShape(dto.fields);
    if (dto.pricingMode === 'FLAT' && (!dto.flatAmount || dto.flatAmount <= 0)) {
      throw new BadRequestException('Set a flat amount for FLAT pricing');
    }

    const existing = await this.prisma.billDefinition.findUnique({
      where: { billerId: user.billerId! },
    });

    const isEditUnlocked = !!existing?.oneTimeEditUnlockedAt;
    if (existing && existing.status === 'PUBLISHED' && !isEditUnlocked) {
      throw new ForbiddenException(
        'This bill is published and locked. Use POST /billers/bill/request-edit to ask support for a one-time correction.',
      );
    }

    const data = {
      name: dto.name,
      fields: dto.fields as unknown as object,
      pricingMode: dto.pricingMode,
      flatAmount: dto.pricingMode === 'FLAT' ? dto.flatAmount : null,
      pricingTable: dto.pricingMode === 'PER_COMBINATION' ? (dto.pricingTable ?? {}) : null,
    };

    const saved = await this.prisma.billDefinition.upsert({
      where: { billerId: user.billerId! },
      create: { billerId: user.billerId!, ...data },
      update: {
        ...data,
        // A permitted edit to a PUBLISHED bill consumes the one-time unlock —
        // it re-locks the moment the edit is saved, per spec.
        ...(isEditUnlocked ? { oneTimeEditUnlockedAt: null } : {}),
      },
    });

    return saved;
  }

  async publishBill(userId: string) {
    const user = await this.requireBillerUser(userId);
    const bill = await this.prisma.billDefinition.findUnique({
      where: { billerId: user.billerId! },
    });
    if (!bill) throw new NotFoundException('Create your bill first — PUT /billers/bill');
    if (bill.status === 'PUBLISHED' && !bill.oneTimeEditUnlockedAt) {
      return bill; // already published — idempotent, not an error
    }

    validatePricingComplete({
      fields: bill.fields as unknown as BillFieldDefinition[],
      pricingMode: bill.pricingMode as 'FLAT' | 'PER_COMBINATION',
      flatAmount: bill.flatAmount?.toString(),
      pricingTable: bill.pricingTable as Record<string, number> | null,
    });

    return this.prisma.billDefinition.update({
      where: { billerId: user.billerId! },
      data: { status: 'PUBLISHED', oneTimeEditUnlockedAt: null },
    });
  }

  /** A biller asking support to correct their locked, published bill — the
   * actual unlock is an admin action (BillersAdminService.grantBillEdit)
   * once they've reviewed the ticket. Reuses the existing generic
   * SupportService.createTicket, same as the Post-UTME assist flow (§5.5) —
   * no support-module changes needed. */
  async requestBillEdit(userId: string, dto: RequestBillEditDto) {
    const user = await this.requireBillerUser(userId);
    const bill = await this.prisma.billDefinition.findUnique({
      where: { billerId: user.billerId! },
    });
    if (!bill) throw new NotFoundException('No bill to request an edit for');
    if (bill.status !== 'PUBLISHED') {
      throw new BadRequestException('Only a published (locked) bill needs a support request to edit');
    }

    const message =
      `Biller "${user.billerLabel ?? ''}" (biller ${user.billerId}) is requesting a one-time edit ` +
      `to their published bill "${bill.name}".` +
      (dto.reason ? `\nReason: ${dto.reason}` : '');

    return this.support.createTicket(userId, 'biller_bill_edit', message, {
      billerId: user.billerId,
      billDefinitionId: bill.id,
      reason: dto.reason ?? null,
    });
  }

  // ---------------------------------------------------------------------
  // Wallet deposit — a biller topping up their own wallet via Paystack.
  // Same "initialize, then verify-on-return" shape as PaymentsService's
  // customer wallet funding, just crediting a BillerWallet instead.
  // ---------------------------------------------------------------------

  async initiateDeposit(userId: string, dto: BillerDepositDto) {
    const user = await this.requireBillerUser(userId);
    const reference = `biller-deposit-${randomUUID()}`;
    return this.paystack.initializeGenericCharge({
      email: user.email,
      amount: dto.amount,
      reference,
      metadata: { kind: 'biller_wallet_deposit', billerId: user.billerId, initiatorUserId: userId },
      callbackPath: '/biller/wallet/deposit-callback',
    });
  }

  async verifyDeposit(userId: string, reference: string) {
    const user = await this.requireBillerUser(userId);
    const result = await this.paystack.verifyTransactionGeneric(reference);

    if (result.status !== 'success') {
      return { credited: false, status: result.status };
    }
    if (result.metadata?.billerId !== user.billerId) {
      throw new UnauthorizedException('This payment does not belong to your biller account');
    }

    const transaction = await this.billerWallet.creditFromDeposit({
      billerId: user.billerId!,
      initiatorUserId: userId,
      amount: result.amount ?? '0',
      providerReference: reference,
      idempotencyKey: `biller-deposit:${reference}`,
    });

    return { credited: true, status: 'success', transaction };
  }

  // ---------------------------------------------------------------------
  // Report-frequency preference — per BILLER USER, not per biller (a joint
  // biller's A and B each choose independently — see schema comment).
  // ---------------------------------------------------------------------

  async getReportPreference(userId: string) {
    await this.requireBillerUser(userId);
    const pref = await this.prisma.billerReportPreference.findUnique({ where: { userId } });
    return pref ?? { userId, frequency: 'DAILY', lastSentAt: null };
  }

  async setReportPreference(userId: string, dto: SetReportPreferenceDto) {
    const user = await this.requireBillerUser(userId);
    return this.prisma.billerReportPreference.upsert({
      where: { userId },
      create: { userId, billerId: user.billerId!, frequency: dto.frequency },
      update: { frequency: dto.frequency },
    });
  }

  // ---------------------------------------------------------------------
  // Payment history — filterable/grouped by the bill's own field keys (e.g.
  // ?department=Computer+Science&level=100L), ready for CSV export, plus a
  // "daily report" download so a biller can write receipts manually. See
  // biller-feature-spec.md.
  // ---------------------------------------------------------------------

  /** `extraFilters` are field-key -> value pairs straight off the bill's own
   * `fields` definition (e.g. department/level/regNo) — validated against
   * the bill so a typo'd key doesn't just silently match nothing. */
  private async findPayments(
    userId: string,
    opts: { from?: string; to?: string; extraFilters?: Record<string, string> },
  ) {
    const user = await this.requireBillerUser(userId);
    const bill = await this.prisma.billDefinition.findUnique({
      where: { billerId: user.billerId! },
    });
    const validKeys = new Set(
      ((bill?.fields as unknown as BillFieldDefinition[]) ?? []).map((f) => f.key),
    );

    const where: any = { billerId: user.billerId!, status: 'SUCCESS' };
    if (opts.from || opts.to) {
      where.createdAt = {};
      if (opts.from) where.createdAt.gte = new Date(opts.from);
      if (opts.to) where.createdAt.lte = new Date(opts.to);
    }

    const payments = await this.prisma.billerPayment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    const filters = Object.entries(opts.extraFilters ?? {}).filter(([k]) => validKeys.has(k));
    if (filters.length === 0) return payments;

    return payments.filter((p) => {
      const values = p.fieldValues as Record<string, string>;
      return filters.every(([k, v]) => values?.[k] === v);
    });
  }

  async listPayments(
    userId: string,
    opts: { from?: string; to?: string; extraFilters?: Record<string, string> },
  ) {
    const payments = await this.findPayments(userId, opts);
    return payments.map((p) => ({
      id: p.id,
      payerName: p.guestName ?? undefined,
      guestEmail: p.guestEmail,
      guestPhone: p.guestPhone,
      userId: p.userId,
      fieldValues: p.fieldValues,
      billAmount: p.billAmount.toFixed(2),
      portalFee: p.portalFee.toFixed(2),
      totalAmount: p.totalAmount.toFixed(2),
      paymentMethod: p.paymentMethod,
      createdAt: p.createdAt,
    }));
  }

  async exportPaymentsCsv(
    userId: string,
    opts: { from?: string; to?: string; extraFilters?: Record<string, string> },
  ): Promise<string> {
    const payments = await this.findPayments(userId, opts);
    const rows = payments.map((p) => {
      const values = (p.fieldValues as Record<string, string>) ?? {};
      return {
        date: p.createdAt.toISOString(),
        payer: p.guestName ?? p.userId ?? '',
        email: p.guestEmail ?? '',
        phone: p.guestPhone ?? '',
        ...values,
        billAmount: p.billAmount.toFixed(2),
        portalFee: p.portalFee.toFixed(2),
        totalAmount: p.totalAmount.toFixed(2),
        paymentMethod: p.paymentMethod,
      };
    });
    return toCsv(rows);
  }

  /** Yesterday's (or an arbitrary date's) payments as CSV — the "download
   * daily reports so I can write receipts manually" feature. Also what the
   * scheduled midnight email (BillerReportsCron) attaches. */
  async dailyReportCsv(userId: string, dateIso?: string): Promise<{ csv: string; date: string }> {
    const date = dateIso ? new Date(dateIso) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const from = new Date(date);
    from.setHours(0, 0, 0, 0);
    const to = new Date(date);
    to.setHours(23, 59, 59, 999);

    const csv = await this.exportPaymentsCsv(userId, {
      from: from.toISOString(),
      to: to.toISOString(),
    });
    return { csv, date: from.toISOString().slice(0, 10) };
  }
}
