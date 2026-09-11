import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { PaystackProvider } from './providers/paystack.provider';
import { FlutterwaveProvider } from './providers/flutterwave.provider';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private prisma: PrismaService,
    private wallet: WalletService,
    private paystack: PaystackProvider,
    private flutterwave: FlutterwaveProvider,
  ) {}

  async provisionVirtualAccount(userId: string, provider: 'paystack' | 'flutterwave' = 'paystack') {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const adapter = provider === 'paystack' ? this.paystack : this.flutterwave;

    const account = await adapter.createDedicatedVirtualAccount({
      userId,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
    });

    await this.prisma.wallet.update({
      where: { userId },
      data: {
        virtualAccountNumber: account.accountNumber,
        virtualAccountBank: account.bankName,
        virtualAccountProvider: provider,
      },
    });

    return account;
  }

  /**
   * Handles a verified Paystack webhook. The controller verifies the
   * signature BEFORE calling this — this method assumes `payload` is
   * trustworthy. Only `charge.success` on a wallet-funding reference credits
   * the wallet; anything else is logged and ignored.
   */
  async handlePaystackWebhook(payload: any) {
    if (payload.event !== 'charge.success') {
      this.logger.log(`Ignoring Paystack event: ${payload.event}`);
      return { handled: false };
    }
    const { reference, amount, metadata } = payload.data;
    const userId = metadata?.userId;
    if (!userId) {
      this.logger.warn(`Paystack webhook missing metadata.userId for ref ${reference}`);
      return { handled: false };
    }

    await this.wallet.creditWalletFromFunding({
      userId,
      amount: String(amount / 100),
      provider: 'paystack',
      providerReference: reference,
      idempotencyKey: `paystack:${reference}`,
    });

    return { handled: true };
  }

  async handleFlutterwaveWebhook(payload: any) {
    if (payload.event !== 'charge.completed' || payload.data?.status !== 'successful') {
      this.logger.log(`Ignoring Flutterwave event: ${payload.event}`);
      return { handled: false };
    }
    const { tx_ref: reference, amount, meta } = payload.data;
    const userId = meta?.userId;
    if (!userId) {
      this.logger.warn(`Flutterwave webhook missing meta.userId for ref ${reference}`);
      return { handled: false };
    }

    await this.wallet.creditWalletFromFunding({
      userId,
      amount: String(amount),
      provider: 'flutterwave',
      providerReference: reference,
      idempotencyKey: `flutterwave:${reference}`,
    });

    return { handled: true };
  }

  generateReference(prefix: string) {
    return `${prefix}-${uuidv4()}`;
  }

  // ---------------------------------------------------------------------
  // Paystack — instant funding, running side by side with manual transfer.
  // ---------------------------------------------------------------------

  /**
   * Starts a Paystack checkout for the signed-in user. Returns an
   * authorization URL the frontend redirects the browser to; Paystack
   * redirects back to /wallet/paystack-callback?reference=... when the
   * customer finishes (or abandons) checkout.
   */
  async initializeFunding(userId: string, amount: string, originHint?: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const reference = this.generateReference('paystack');
    return this.paystack.initializeCardCharge({
      userId,
      email: user.email,
      amount,
      reference,
      originHint,
    });
  }

  /**
   * Called from the callback page the customer lands on after Paystack
   * checkout. Verifies directly against Paystack's API (doesn't trust the
   * query string) and credits the wallet using the exact same idempotency
   * key the webhook handler uses (`paystack:${reference}`), so this is safe
   * to call even if the webhook already processed the same reference — and
   * vice versa, once this app has a public webhook URL in production.
   */
  async verifyAndCreditPaystack(reference: string, requestingUserId: string) {
    const result = await this.paystack.verifyTransaction(reference);

    if (result.status !== 'success') {
      return { credited: false, status: result.status };
    }
    if (!result.userId) {
      this.logger.warn(`Paystack verify ${reference} succeeded but has no metadata.userId`);
      return { credited: false, status: 'success', error: 'missing-metadata' };
    }
    if (result.userId !== requestingUserId) {
      // Whoever is viewing the callback page must be the same customer who
      // started the payment — otherwise this becomes a way to credit an
      // arbitrary wallet just by knowing someone else's reference.
      throw new UnauthorizedException('This payment does not belong to the signed-in user');
    }

    const transaction = await this.wallet.creditWalletFromFunding({
      userId: result.userId,
      amount: result.amount ?? '0',
      provider: 'paystack',
      providerReference: reference,
      idempotencyKey: `paystack:${reference}`,
    });

    return { credited: true, status: 'success', transaction };
  }
}
