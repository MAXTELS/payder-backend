import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { BillerPaymentsService } from './biller-payments.service';
import { PayBillFieldsDto, PayBillGuestDto } from './dto/pay-bill.dto';

/**
 * Customer/guest-facing bill browsing + payment — the customer Bills tab's
 * "School" (etc.) categories, and the new public /pay-bill web flow that
 * lets a non-logged-in visitor pay via Paystack. Everything except the
 * wallet-payment endpoint is @Public() — a guest must be able to browse and
 * pay without ever authenticating. See biller-feature-spec.md.
 */
@Controller('bill-pay')
export class BillerPaymentsController {
  constructor(private billerPayments: BillerPaymentsService) {}

  @Public()
  @Get('categories')
  categories() {
    return this.billerPayments.listCategories();
  }

  @Public()
  @Get('categories/:type/billers')
  billersByCategory(@Param('type') type: string) {
    return this.billerPayments.listBillersByCategory(type);
  }

  @Public()
  @Get('billers/:billerId/bill')
  billDetail(@Param('billerId') billerId: string) {
    return this.billerPayments.getBillDetail(billerId);
  }

  @Public()
  @Post('billers/:billerId/quote')
  quote(@Param('billerId') billerId: string, @Body() dto: PayBillFieldsDto) {
    return this.billerPayments.quote(billerId, dto.fieldValues);
  }

  // Authenticated (customer) — default global JwtAuthGuard applies, no
  // @Public() here. Settles immediately; no redirect/callback needed.
  @Post('billers/:billerId/pay/wallet')
  payWithWallet(
    @Param('billerId') billerId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PayBillFieldsDto,
  ) {
    return this.billerPayments.payWithWallet(user.id, billerId, dto);
  }

  @Public()
  @Post('billers/:billerId/pay/guest')
  payAsGuest(@Param('billerId') billerId: string, @Body() dto: PayBillGuestDto) {
    return this.billerPayments.initiateGuestPayment(billerId, dto);
  }

  // The page at WEB_APP_URL/pay-bill/callback (see PaystackProvider's
  // callbackPath above) hits this once Paystack redirects the guest back.
  @Public()
  @Get('verify/:reference')
  verify(@Param('reference') reference: string) {
    return this.billerPayments.verifyGuestPayment(reference);
  }
}
