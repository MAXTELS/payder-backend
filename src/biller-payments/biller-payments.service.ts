import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService, SYSTEM_ACCOUNTS } from '../wallet/ledger.service';
import { WalletService } from '../wallet/wallet.service';
import { PaystackProvider } from '../payments/providers/paystack.provider';
import {
  BillFieldDefinition,
  PORTAL_FEE_NGN,
  resolveBillAmount,
  validateFieldValues,
} from '../billers/bill-pricing.util';
import { PayBillFieldsDto, PayBillGuestDto } from './dto/pay-bill.dto';

/**
 * Customer/guest-facing side of the biller-catalog feature: browsing
 * published bills by category and paying one, either by wallet debit
 * (logged-in customer) or Paystack (guest — a NEW capability added
 * alongside this feature so a non-logged-in visitor can still pay a bill).
 * See biller-feature-spec.md for the full design, in particular the 3-way
 * ledger split: whoever/whatever paid, the biller's wallet gets `billAmount`
 * and system:revenue gets the flat ₦110 `portalFee` — both credited from the
 * same debit source (system:suspense for the wallet path, since
 * WalletService.debitWalletForPurchase already moved the money there;
 * system:provider-float:paystack for the guest path, since Paystack is the
 * one who actually received the money).
 */
@Injectable()
export class BillerPaymentsService {
  private guestUserIdCache: string | null = null;

  constructor(
    private prisma: PrismaService,
    private ledger: LedgerService,
    private wallet: WalletService,
    private paystack: PaystackProvider,
  ) {}

  // ---------------------------------------------------------------------
  // Public browsing — deliberately fetched from the DB every time (never
  // hardcoded), per the explicit "bills are not to be hardcoded" requirement.
  // Only PUBLISHED bills on active billers are ever visible here.
  // ---------------------------------------------------------------------

  async listCategories(): Promise<string[]> {
    const rows = await this.prisma.biller.findMany({
      where: { isActive: true, bill: { status: 'PUBLISHED' } },
      select: { type: true },
      distinct: ['type'],
      orderBy: { type: 'asc' },
    });
    return rows.map((r) => r.type);
  }

  async listBillersByCategory(type: string) {
    return this.prisma.biller.findMany({
      where: { type, isActive: true, bill: { status: 'PUBLISHED' } },
      select: { id: true, name: true, type: true, bill: { select: { name: true } } },
      orderBy: { name: 'asc' },
    });
  }

  private async loadPublishedBill(billerId: string) {
    const biller = await this.prisma.biller.findUnique({
      where: { id: billerId },
      include: { bill: true },
    });
    if (!biller || !biller.isActive || !biller.bill || biller.bill.status !== 'PUBLISHED') {
      throw new NotFoundException('This bill is not available');
    }
    return { biller, bill: biller.bill };
  }

  async getBillDetail(billerId: string) {
    const { biller, bill } = await this.loadPublishedBill(billerId);
    return {
      billerId: biller.id,
      billerName: biller.name,
      billName: bill.name,
      fields: bill.fields,
      pricingMode: bill.pricingMode,
      flatAmount: bill.flatAmount?.toFixed(2) ?? null,
      pricingTable: bill.pricingTable,
      portalFee: PORTAL_FEE_NGN.toFixed(2),
    };
  }

  private computeAmount(
    bill: { fields: Prisma.JsonValue; pricingMode: string; flatAmount: Prisma.Decimal | null; pricingTable: Prisma.JsonValue },
    fieldValues: Record<string, string>,
  ) {
    const fields = bill.fields as unknown as BillFieldDefinition[];
    validateFieldValues(fields, fieldValues);
    const billAmount = resolveBillAmount(
      {
        fields,
        pricingMode: bill.pricingMode as 'FLAT' | 'PER_COMBINATION',
        flatAmount: bill.flatAmount?.toString(),
        pricingTable: bill.pricingTable as Record<string, number> | null,
      },
      fieldValues,
    );
    const portalFee = PORTAL_FEE_NGN;
    return { billAmount, portalFee, totalAmount: billAmount + portalFee };
  }

  /** Preview endpoint's logic, reused by both payment paths below so the
   * amount a customer/guest is quoted is exactly what gets charged. */
  async quote(billerId: string, fieldValues: Record<string, string>) {
    const { bill } = await this.loadPublishedBill(billerId);
    return this.computeAmount(bill, fieldValues);
  }

  /** Posts the 3-way settlement inside an existing DB transaction — the
   * biller wallet gets `billAmount`, system:revenue gets `portalFee`, both
   * debited from `debitAccountId` (suspense for a wallet payment, Paystack's
   * provider-float for a guest payment). Marks the Transaction and
   * BillerPayment SUCCESS. */
  private async settleWithinTx(
    tx: Prisma.TransactionClient,
    params: {
      paymentId: string;
      transactionId: string;
      billerId: string;
      billAmount: Prisma.Decimal | number | string;
      portalFee: Prisma.Decimal | number | string;
      debitAccountId: string;
    },
  ) {
    const billerWallet = await tx.billerWallet.findUnique({
      where: { billerId: params.billerId },
      include: { ledgerAccount: true },
    });
    if (!billerWallet?.ledgerAccount) {
      throw new NotFoundException('Biller wallet not found');
    }
    const revenueAccount = await this.ledger.getOrCreateSystemAccount(SYSTEM_ACCOUNTS.REVENUE);

    await this.ledger.postEntry(tx, {
      transactionId: params.transactionId,
      debitAccountId: params.debitAccountId,
      creditAccountId: billerWallet.ledgerAccount.id,
      amount: params.billAmount,
    });
    await this.ledger.postEntry(tx, {
      transactionId: params.transactionId,
      debitAccountId: params.debitAccountId,
      creditAccountId: revenueAccount.id,
      amount: params.portalFee,
    });

    await tx.transaction.update({
      where: { id: params.transactionId },
      data: { status: 'SUCCESS', completedAt: new Date() },
    });

    return tx.billerPayment.update({
      where: { id: params.paymentId },
      data: { status: 'SUCCESS', completedAt: new Date() },
    });
  }

  // ---------------------------------------------------------------------
  // Logged-in customer — wallet debit, settled immediately (no external
  // gateway wait, unlike the guest/Paystack path below).
  // ---------------------------------------------------------------------

  async payWithWallet(userId: string, billerId: string, dto: PayBillFieldsDto) {
    const { bill } = await this.loadPublishedBill(billerId);
    const { billAmount, portalFee, totalAmount } = this.computeAmount(bill, dto.fieldValues);

    const idempotencyKey = `biller-payment:wallet:${randomUUID()}`;
    const heldTransaction = await this.wallet.debitWalletForPurchase({
      userId,
      amount: totalAmount,
      type: 'BILLER_BILL_PAYMENT',
      idempotencyKey,
      metadata: { billerId, fieldValues: dto.fieldValues },
    });

    const payment = await this.prisma.billerPayment.create({
      data: {
        billerId,
        billDefinitionId: bill.id,
        userId,
        fieldValues: dto.fieldValues as unknown as object,
        billAmount,
        portalFee,
        totalAmount,
        paymentMethod: 'WALLET',
        status: 'PENDING',
        transactionId: heldTransaction.id,
      },
    });

    const suspenseAccount = await this.ledger.getOrCreateSystemAccount(SYSTEM_ACCOUNTS.SUSPENSE);

    try {
      return await this.prisma.$transaction((tx) =>
        this.settleWithinTx(tx, {
          paymentId: payment.id,
          transactionId: heldTransaction.id,
          billerId,
          billAmount,
          portalFee,
          debitAccountId: suspenseAccount.id,
        }),
      );
    } catch (err) {
      // Settlement failed after the wallet was already debited (e.g. the
      // biller's wallet vanished mid-flight) — reverse the debit rather than
      // leave the customer's money stuck in suspense with no bill delivered.
      await this.wallet.reversePendingDebit(
        heldTransaction.id,
        'Bill payment could not be completed — amount refunded automatically.',
      );
      throw new BadRequestException(
        'This payment could not be completed. The amount has been returned to your wallet.',
      );
    }
  }

  // ---------------------------------------------------------------------
  // Guest — Paystack. initiateGuestPayment creates the BillerPayment row
  // PENDING (unpriced settlement, no Transaction yet — a guest has no User
  // row for Transaction.userId until settlement, see getGuestSystemUserId)
  // and starts checkout; verifyGuestPayment is called from the callback page
  // and is what actually settles it.
  // ---------------------------------------------------------------------

  async initiateGuestPayment(billerId: string, dto: PayBillGuestDto, originHint?: string) {
    const { bill } = await this.loadPublishedBill(billerId);
    const { billAmount, portalFee, totalAmount } = this.computeAmount(bill, dto.fieldValues);

    const reference = `bill-guest-${randomUUID()}`;
    const payment = await this.prisma.billerPayment.create({
      data: {
        billerId,
        billDefinitionId: bill.id,
        guestName: dto.guestName,
        guestEmail: dto.guestEmail,
        guestPhone: dto.guestPhone,
        fieldValues: dto.fieldValues as unknown as object,
        billAmount,
        portalFee,
        totalAmount,
        paymentMethod: 'PAYSTACK',
        status: 'PENDING',
        paystackReference: reference,
      },
    });

    const init = await this.paystack.initializeGenericCharge({
      email: dto.guestEmail,
      amount: totalAmount,
      reference,
      metadata: { kind: 'biller_bill_payment', billerPaymentId: payment.id },
      callbackPath: '/pay-bill/callback',
      originHint,
    });

    return { authorizationUrl: init.authorizationUrl, reference, billerPaymentId: payment.id };
  }

  /** Lazily creates (once) a synthetic, permanently-inactive system User row
   * to satisfy Transaction.userId (required, not nullable) for a guest
   * payment — there is no real customer account to attribute it to, and
   * adding a nullable-column migration mid-feature was judged riskier than
   * this well-established "system row" pattern (see PROVIDER_FLOAT accounts,
   * which are the same idea for the ledger side). */
  private async getGuestSystemUserId(): Promise<string> {
    if (this.guestUserIdCache) return this.guestUserIdCache;

    const email = 'guest-checkout@payder.internal';
    let user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      const passwordHash = await bcrypt.hash(randomUUID(), 12);
      user = await this.prisma.user.create({
        data: {
          email,
          phone: '+0000000000',
          firstName: 'Guest',
          lastName: 'Checkout',
          passwordHash,
          role: 'CUSTOMER',
          isActive: false,
        },
      });
    }
    this.guestUserIdCache = user.id;
    return user.id;
  }

  async verifyGuestPayment(reference: string) {
    const payment = await this.prisma.billerPayment.findUnique({ where: { paystackReference: reference } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.status === 'SUCCESS') {
      return { credited: true, status: 'success', payment };
    }

    const result = await this.paystack.verifyTransactionGeneric(reference);
    if (result.status !== 'success') {
      return { credited: false, status: result.status };
    }

    const idempotencyKey = `biller-payment:guest:${reference}`;
    const guestUserId = await this.getGuestSystemUserId();
    const floatAccount = await this.ledger.getOrCreateSystemAccount(
      SYSTEM_ACCOUNTS.PROVIDER_FLOAT_PAYSTACK,
    );

    const settled = await this.prisma.$transaction(async (tx) => {
      let transaction = await tx.transaction.findUnique({ where: { idempotencyKey } });
      if (!transaction) {
        transaction = await tx.transaction.create({
          data: {
            userId: guestUserId,
            type: 'BILLER_BILL_PAYMENT',
            status: 'PENDING',
            amount: payment.totalAmount,
            providerReference: reference,
            idempotencyKey,
          },
        });
        await tx.billerPayment.update({
          where: { id: payment.id },
          data: { transactionId: transaction.id },
        });
      }

      const freshPayment = await tx.billerPayment.findUniqueOrThrow({ where: { id: payment.id } });
      if (freshPayment.status === 'SUCCESS') return freshPayment;

      return this.settleWithinTx(tx, {
        paymentId: payment.id,
        transactionId: transaction.id,
        billerId: payment.billerId,
        billAmount: payment.billAmount,
        portalFee: payment.portalFee,
        debitAccountId: floatAccount.id,
      });
    });

    return { credited: true, status: 'success', payment: settled };
  }
}
