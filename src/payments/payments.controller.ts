import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { PaymentsService } from './payments.service';
import { PaystackProvider } from './providers/paystack.provider';
import { FlutterwaveProvider } from './providers/flutterwave.provider';
import { FundWalletDto } from './dto/fund-wallet.dto';

@Controller('payments')
export class PaymentsController {
  constructor(
    private paymentsService: PaymentsService,
    private paystack: PaystackProvider,
    private flutterwave: FlutterwaveProvider,
  ) {}

  @Post('virtual-account')
  provisionVirtualAccount(@CurrentUser() user: AuthenticatedUser) {
    return this.paymentsService.provisionVirtualAccount(user.id);
  }

  // ---------------------------------------------------------------------
  // Paystack — instant card/bank funding, alongside manual bank transfer.
  // ---------------------------------------------------------------------

  @Post('paystack/fund')
  initializePaystackFunding(@CurrentUser() user: AuthenticatedUser, @Body() dto: FundWalletDto) {
    return this.paymentsService.initializeFunding(user.id, dto.amount);
  }

  /**
   * The customer's browser hits this after being redirected back from
   * Paystack checkout (see /wallet/paystack-callback). Verifies against
   * Paystack directly and credits the wallet — this is what makes funding
   * work in local dev, where Paystack's webhook can never reach localhost.
   * Safe to also run in production alongside the webhook below: both use the
   * same idempotency key, so only the first to arrive actually credits.
   */
  @Get('paystack/verify/:reference')
  verifyPaystackPayment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('reference') reference: string,
  ) {
    return this.paymentsService.verifyAndCreditPaystack(reference, user.id);
  }

  // This route is verified against Paystack/Flutterwave's raw request body,
  // wired up globally in main.ts's custom express.json({ verify }) — needed
  // because HMAC/hash verification breaks the moment the body is re-
  // serialized from parsed JSON instead of the exact bytes Paystack sent.
  @Public()
  @Post('webhooks/paystack')
  async paystackWebhook(
    @Headers('x-paystack-signature') signature: string,
    @Req() req: Request,
  ) {
    const rawBody = (req as any).rawBody ?? JSON.stringify(req.body);
    const result = this.paystack.verifyWebhookSignature(signature, rawBody);
    if (!result.isValid) throw new UnauthorizedException('Invalid webhook signature');
    return this.paymentsService.handlePaystackWebhook(result.raw);
  }

  @Public()
  @Post('webhooks/flutterwave')
  async flutterwaveWebhook(
    @Headers('verif-hash') hash: string,
    @Req() req: Request,
  ) {
    const rawBody = (req as any).rawBody ?? JSON.stringify(req.body);
    const result = this.flutterwave.verifyWebhookSignature(hash, rawBody);
    if (!result.isValid) throw new UnauthorizedException('Invalid webhook signature');
    return this.paymentsService.handleFlutterwaveWebhook(result.raw);
  }
}
