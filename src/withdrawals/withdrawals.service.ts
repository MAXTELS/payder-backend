import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { BillerWalletService } from '../billers/biller-wallet.service';
import { EmailService } from '../common/email/email.service';
import { renderEmailHtml, paragraphHtml, escapeHtml } from '../common/email/email-template';
import { verifyTransactionPin } from '../common/security/transaction-pin.util';
import { CreateWithdrawalDto } from './dto/create-withdrawal.dto';
import { RejectWithdrawalDto } from './dto/reject-withdrawal.dto';
import { MarkWithdrawalPaidDto } from './dto/mark-withdrawal-paid.dto';

export interface NgnBank {
  name: string;
  code: string;
}

// Static fallback list — used if the Paystack /bank call fails (network
// blip, missing/invalid key, rate limit) so the withdrawal form never shows
// an empty dropdown. Covers the major NGN banks; the frontend always also
// offers a freeform "Other" option regardless of this list's completeness.
const FALLBACK_NGN_BANKS: NgnBank[] = [
  { name: 'Access Bank', code: '044' },
  { name: 'Citibank Nigeria', code: '023' },
  { name: 'Ecobank Nigeria', code: '050' },
  { name: 'Fidelity Bank', code: '070' },
  { name: 'First Bank of Nigeria', code: '011' },
  { name: 'First City Monument Bank (FCMB)', code: '214' },
  { name: 'Globus Bank', code: '00103' },
  { name: 'Guaranty Trust Bank (GTBank)', code: '058' },
  { name: 'Heritage Bank', code: '030' },
  { name: 'Keystone Bank', code: '082' },
  { name: 'Kuda Bank', code: '50211' },
  { name: 'Moniepoint MFB', code: '50515' },
  { name: 'Opay', code: '999992' },
  { name: 'Palmpay', code: '999991' },
  { name: 'Polaris Bank', code: '076' },
  { name: 'Providus Bank', code: '101' },
  { name: 'Stanbic IBTC Bank', code: '221' },
  { name: 'Standard Chartered Bank', code: '068' },
  { name: 'Sterling Bank', code: '232' },
  { name: 'Union Bank of Nigeria', code: '032' },
  { name: 'United Bank For Africa (UBA)', code: '033' },
  { name: 'Unity Bank', code: '215' },
  { name: 'Wema Bank', code: '035' },
  { name: 'Zenith Bank', code: '057' },
];

/**
 * Withdrawal (wallet → external bank account) requests — for a CUSTOMER's
 * own wallet via create()/listMine(), and since 2026-09-10 for a BILLER's
 * wallet via createForBiller() (see BillersService, which is the only
 * caller of that method — a biller-user never hits this service directly
 * through WithdrawalsController, which stays customer-only). Both share one
 * admin queue (listQueue/markPaid/reject below) — a biller withdrawal is
 * just a normal WithdrawalRequest row with `billerId` set, per the confirmed
 * "reuse the existing queue" decision (biller-feature-spec.md).
 *
 * Deliberately admin-reviewed rather than automatic (via Paystack Transfers
 * or similar): outbound-to-arbitrary-bank-account is the riskiest
 * money-movement direction in the app, and PAYDER doesn't yet have a
 * Transfers provider integrated or vetted. Same "customer/biller holds,
 * admin resolves" pattern as ManualPaymentsService/WalletFundingService.
 *
 * The debit happens up-front on create()/createForBiller() (money leaves the
 * ledger into suspense immediately), NOT on admin approval — this matches
 * the "purchase" pattern (bills/exams) rather than the "funding" pattern
 * (wallet-funding, which never touches the ledger until an admin approves
 * it) because a withdrawal genuinely decreases spendable balance the moment
 * it's asked for; letting the same money keep being spendable elsewhere
 * while the request sits in the queue would be a double-spend hole.
 * Reject() reverses the debit with WalletService.reversePendingDebit — that
 * method reads the original debit's own ledger entry rather than assuming a
 * customer wallet, so it reverses a biller withdrawal's debit correctly too
 * with no changes needed here.
 */
@Injectable()
export class WithdrawalsService {
  private readonly logger = new Logger(WithdrawalsService.name);
  private bankListCache: { fetchedAt: number; banks: NgnBank[] } | null = null;
  private readonly bankListTtlMs = 24 * 60 * 60 * 1000; // 24h — bank lists rarely change

  constructor(
    private prisma: PrismaService,
    private wallet: WalletService,
    private billerWallet: BillerWalletService,
    private email: EmailService,
    private http: HttpService,
    private config: ConfigService,
  ) {}

  /**
   * 2026-09-13: replaced the old flat-tiered fee (₦100 below ₦10k, ₦150 at
   * or above) with a straight percentage, per Jude's app-wide fee
   * restructure — 1.3% of the withdrawal amount, capped so the fee itself
   * never exceeds ₦1,500 even on a very large withdrawal. Signature/name
   * unchanged (still `feeFor(amount): number`) since nothing else about the
   * withdrawal flow needed to change — `prepare()` below just calls this.
   */
  feeFor(amount: number): number {
    const percent = Number(this.config.get<string>('WITHDRAWAL_FEE_PERCENT') ?? '1.3');
    const cap = Number(this.config.get<string>('WITHDRAWAL_FEE_CAP') ?? '1500');
    const fee = (amount * percent) / 100;
    return Math.min(Math.round(fee * 100) / 100, cap);
  }

  async listBanks(): Promise<NgnBank[]> {
    if (this.bankListCache && Date.now() - this.bankListCache.fetchedAt < this.bankListTtlMs) {
      return this.bankListCache.banks;
    }

    const secretKey = this.config.get<string>('PAYSTACK_SECRET_KEY');
    if (!secretKey) {
      return FALLBACK_NGN_BANKS;
    }

    try {
      const res = await firstValueFrom(
        this.http.get('https://api.paystack.co/bank', {
          // type=nuban restricts to real bank accounts (what a 10-digit
          // account number actually targets) — without it Paystack also
          // returns mobile-money/USSD entries that can repeat the same
          // institution under a different "type" with the same `code`,
          // which is what produced duplicate-key React warnings on the
          // frontend dropdown.
          params: { country: 'nigeria', currency: 'NGN', type: 'nuban' },
          headers: { Authorization: `Bearer ${secretKey}` },
        }),
      );
      const raw: NgnBank[] = (res.data?.data ?? [])
        .filter((b: any) => b?.name && b?.code)
        .map((b: any) => ({ name: b.name, code: b.code }));

      // Belt-and-suspenders de-dupe by code even with the type filter above
      // — Paystack's list has occasionally repeated an entry verbatim.
      const seen = new Set<string>();
      const banks = raw.filter((b) => {
        if (seen.has(b.code)) return false;
        seen.add(b.code);
        return true;
      });

      if (banks.length === 0) {
        return FALLBACK_NGN_BANKS;
      }
      this.bankListCache = { fetchedAt: Date.now(), banks };
      return banks;
    } catch (err) {
      this.logger.warn(`Paystack bank list fetch failed, using fallback list: ${err}`);
      return FALLBACK_NGN_BANKS;
    }
  }

  /** Shared validation + fee math for both create() and createForBiller(). */
  private prepare(dto: CreateWithdrawalDto | { amount: string; accountNumber: string; confirmAccountNumber: string }) {
    if (dto.accountNumber !== dto.confirmAccountNumber) {
      throw new BadRequestException('Account number and confirmation do not match');
    }

    const amount = Number(dto.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Enter a valid withdrawal amount');
    }

    const fee = this.feeFor(amount);
    const totalDebit = amount + fee;
    return { amount, fee, totalDebit };
  }

  async create(userId: string, dto: CreateWithdrawalDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { transactionPinHash: true },
    });
    if (!user) throw new NotFoundException('User not found');
    await verifyTransactionPin(user, dto.pin);

    const { amount, fee, totalDebit } = this.prepare(dto);
    const idempotencyKey = `withdrawal:${userId}:${randomUUID()}`;

    const heldTransaction = await this.wallet.debitWalletForPurchase({
      userId,
      amount: totalDebit,
      type: 'TRANSFER',
      idempotencyKey,
      fee,
      metadata: {
        withdrawalAmount: amount,
        withdrawalFee: fee,
        bankName: dto.bankName,
        accountNumber: dto.accountNumber,
        accountName: dto.accountName,
      },
    });

    // The debit above already committed (debitWalletForPurchase runs its own
    // DB transaction) — if creating the WithdrawalRequest row fails for any
    // reason (a DB blip, a stale/unmigrated Prisma Client, whatever), the
    // customer must not be left with money silently gone from their wallet
    // and no record of why. Reverse the debit and surface a clear error
    // instead of letting it fall through as an orphaned PENDING transaction.
    try {
      return await this.prisma.withdrawalRequest.create({
        data: {
          userId,
          amount,
          fee,
          totalDebit,
          bankName: dto.bankName,
          accountNumber: dto.accountNumber,
          accountName: dto.accountName,
          heldTransactionId: heldTransaction.id,
        },
      });
    } catch (err) {
      this.logger.error(
        `Withdrawal request creation failed after debit — reversing transaction ${heldTransaction.id}`,
        err instanceof Error ? err.stack : String(err),
      );
      await this.wallet.reversePendingDebit(
        heldTransaction.id,
        'Withdrawal request could not be saved — amount refunded automatically.',
      );
      throw new BadRequestException(
        'Could not submit your withdrawal request — the amount has been returned to your wallet. Please try again, and let support know if this keeps happening.',
      );
    }
  }

  /**
   * Biller equivalent of create() — debits the BILLER wallet (not a personal
   * one) and tags the resulting WithdrawalRequest with `billerId`. Called
   * from BillersService: directly for a single (non-joint) biller's
   * withdrawal, or once a joint biller's second signer approves a
   * BillerWithdrawalDraft — either way, by the time this runs the money is
   * meant to actually leave the wallet right now.
   */
  async createForBiller(params: {
    billerId: string;
    initiatorUserId: string;
    amount: string;
    bankName: string;
    accountNumber: string;
    confirmAccountNumber: string;
    accountName: string;
  }) {
    const { amount, fee, totalDebit } = this.prepare(params);
    const idempotencyKey = `withdrawal:biller:${params.billerId}:${randomUUID()}`;

    const heldTransaction = await this.billerWallet.debitForWithdrawal({
      billerId: params.billerId,
      initiatorUserId: params.initiatorUserId,
      amount: totalDebit,
      idempotencyKey,
      fee,
      metadata: {
        withdrawalAmount: amount,
        withdrawalFee: fee,
        bankName: params.bankName,
        accountNumber: params.accountNumber,
        accountName: params.accountName,
      },
    });

    try {
      return await this.prisma.withdrawalRequest.create({
        data: {
          userId: params.initiatorUserId,
          billerId: params.billerId,
          amount,
          fee,
          totalDebit,
          bankName: params.bankName,
          accountNumber: params.accountNumber,
          accountName: params.accountName,
          heldTransactionId: heldTransaction.id,
        },
      });
    } catch (err) {
      this.logger.error(
        `Biller withdrawal request creation failed after debit — reversing transaction ${heldTransaction.id}`,
        err instanceof Error ? err.stack : String(err),
      );
      await this.wallet.reversePendingDebit(
        heldTransaction.id,
        'Withdrawal request could not be saved — amount refunded automatically.',
      );
      throw new BadRequestException(
        'Could not submit this withdrawal request — the amount has been returned to the biller wallet. Please try again.',
      );
    }
  }

  listMine(userId: string) {
    return this.prisma.withdrawalRequest.findMany({
      where: { userId },
      orderBy: { submittedAt: 'desc' },
    });
  }

  /** Every withdrawal request for a given biller (customer withdrawals never
   * carry a billerId, so this is unambiguous). */
  listMineForBiller(billerId: string) {
    return this.prisma.withdrawalRequest.findMany({
      where: { billerId },
      orderBy: { submittedAt: 'desc' },
    });
  }

  // Admin queue — oldest pending first, matching the manual-payments/
  // wallet-funding queues. `biller` is included (null for a customer
  // withdrawal) so the admin UI can tag biller requests without a second
  // endpoint — see the confirmed "reuse the existing queue" decision.
  listQueue(status?: string) {
    return this.prisma.withdrawalRequest.findMany({
      where: status ? { status: status as any } : undefined,
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
        biller: { select: { id: true, name: true, type: true } },
      },
      orderBy: { submittedAt: 'asc' },
    });
  }

  async markPaid(id: string, adminId: string, dto: MarkWithdrawalPaidDto) {
    const request = await this.prisma.withdrawalRequest.findUnique({
      where: { id },
      include: { user: true, biller: true },
    });
    if (!request) throw new NotFoundException('Withdrawal request not found');
    if (request.status !== 'PENDING') {
      throw new BadRequestException(`Request is already ${request.status.toLowerCase()}`);
    }

    await this.prisma.transaction.update({
      where: { id: request.heldTransactionId },
      data: {
        status: 'SUCCESS',
        completedAt: new Date(),
        providerReference: dto.providerConfirmationRef,
      },
    });

    const updated = await this.prisma.withdrawalRequest.update({
      where: { id },
      data: {
        status: 'PAID',
        assignedAdminId: adminId,
        providerConfirmationRef: dto.providerConfirmationRef,
        resolvedAt: new Date(),
      },
    });

    const payeeLabel = request.biller ? request.biller.name : request.user.firstName;
    await this.email.send({
      to: request.user.email,
      subject: 'PAYDER — your withdrawal has been paid',
      text:
        `Hi ${payeeLabel},\n\nWe have sent NGN ${request.amount} to your ${request.bankName} ` +
        `account (${request.accountNumber}). NGN ${request.fee} withdrawal fee was applied.\n\n` +
        `Thank you for using PAYDER.`,
      html: renderEmailHtml({
        heading: 'Your withdrawal has been paid',
        bodyHtml:
          paragraphHtml(`Hi ${payeeLabel},`) +
          paragraphHtml(
            `We've sent <strong>NGN ${request.amount}</strong> to your ${request.bankName} account ` +
              `(${request.accountNumber}). A withdrawal fee of NGN ${request.fee} was applied.`,
          ) +
          paragraphHtml('Thank you for using PAYDER.'),
      }),
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actorRole: 'ADMIN',
        action: 'withdrawal.paid',
        targetEntity: 'WithdrawalRequest',
        targetId: id,
        afterState: { status: 'PAID', billerId: request.billerId },
      },
    });

    return updated;
  }

  async reject(id: string, adminId: string, dto: RejectWithdrawalDto) {
    const request = await this.prisma.withdrawalRequest.findUnique({
      where: { id },
      include: { user: true, biller: true },
    });
    if (!request) throw new NotFoundException('Withdrawal request not found');
    if (request.status !== 'PENDING') {
      throw new BadRequestException(`Request is already ${request.status.toLowerCase()}`);
    }

    await this.wallet.reversePendingDebit(request.heldTransactionId, dto.reason);

    const updated = await this.prisma.withdrawalRequest.update({
      where: { id },
      data: {
        status: 'REJECTED',
        assignedAdminId: adminId,
        rejectionReason: dto.reason,
        resolvedAt: new Date(),
      },
    });

    const payeeLabel = request.biller ? request.biller.name : request.user.firstName;
    await this.email.send({
      to: request.user.email,
      subject: 'PAYDER — your withdrawal request was declined',
      text:
        `Hi ${payeeLabel},\n\nWe could not process your withdrawal request for NGN ` +
        `${request.amount}. Reason: ${dto.reason}\n\nThe full amount (including the withdrawal fee) has ` +
        `been returned to the wallet. If you believe this is a mistake, please contact support.`,
      html: renderEmailHtml({
        heading: 'Your withdrawal request was declined',
        bodyHtml:
          paragraphHtml(`Hi ${payeeLabel},`) +
          paragraphHtml(
            `We couldn't process your withdrawal request for NGN ${request.amount}.<br/>` +
              `<strong>Reason:</strong> ${escapeHtml(dto.reason)}`,
          ) +
          paragraphHtml(
            'The full amount (including the withdrawal fee) has been returned to your wallet. ' +
              'If you believe this is a mistake, please contact support.',
          ),
      }),
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actorRole: 'ADMIN',
        action: 'withdrawal.rejected',
        targetEntity: 'WithdrawalRequest',
        targetId: id,
        afterState: { status: 'REJECTED', reason: dto.reason, billerId: request.billerId },
      },
    });

    return updated;
  }
}
