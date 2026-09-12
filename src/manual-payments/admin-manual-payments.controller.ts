import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { ManualPaymentsService } from './manual-payments.service';
import { MarkPaidDto } from './dto/mark-paid.dto';
import { RejectManualPaymentDto } from './dto/reject-manual-payment.dto';
import { GenerateDemoRrrDto } from './dto/generate-demo-rrr.dto';

/**
 * Admin side of the manual invoice-payment queue (§5.4b, §9). Kept as its
 * own controller under /admin/manual-payments rather than folded into
 * AdminController, matching how SupportController stays separate from
 * AdminController for customer-care — this way "everything about the manual
 * payment flow" is a one-directory read.
 */
@Roles('ADMIN')
@Controller('admin/manual-payments')
export class AdminManualPaymentsController {
  constructor(private manualPayments: ManualPaymentsService) {}

  @Get()
  queue(@Query('status') status?: string) {
    return this.manualPayments.listQueue(status);
  }

  @Patch(':id/paid')
  markPaid(
    @Param('id') id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: MarkPaidDto,
  ) {
    return this.manualPayments.markPaid(id, admin.id, dto);
  }

  @Patch(':id/reject')
  reject(
    @Param('id') id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: RejectManualPaymentDto,
  ) {
    return this.manualPayments.reject(id, admin.id, dto);
  }

  // Test-only: generates a throwaway RRR via Remita's own public demo
  // credentials so the "Pay a Remita invoice" screen can be exercised
  // end-to-end without waiting on a real biller to hand you one — see
  // RemitaDemoProvider's header comment for exactly what this does and does
  // not guarantee.
  @Post('remita/generate-demo-rrr')
  generateDemoRrr(@Body() dto: GenerateDemoRrrDto) {
    return this.manualPayments.generateDemoRrr(dto);
  }
}
