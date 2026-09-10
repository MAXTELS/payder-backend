import { Body, Controller, Get, Header, Param, Post, StreamableFile } from '@nestjs/common';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { ManualPaymentsService } from './manual-payments.service';
import { LookupManualPaymentDto } from './dto/lookup-manual-payment.dto';
import { CreateManualPaymentDto } from './dto/create-manual-payment.dto';
import { PayRemitaBillDto } from './dto/pay-remita-bill.dto';

/**
 * Customer-facing side of the manual invoice-payment flow (§5.4b): submit a
 * Remita/eTranzact invoice reference, get it validated and held against the
 * wallet, then track it until an admin resolves it and a receipt appears.
 *
 * REMITA now has a real, automatic path (lookup/pay/status below) instead of
 * the generic admin-mediated one — ETRANZACT still uses lookup()/create().
 */
@Controller('manual-payments')
export class ManualPaymentsController {
  constructor(private manualPayments: ManualPaymentsService) {}

  @Get('remita/lookup/:rrr')
  lookupRemita(@Param('rrr') rrr: string) {
    return this.manualPayments.lookupRemitaBill(rrr);
  }

  @Post('remita/pay')
  payRemita(@CurrentUser() user: AuthenticatedUser, @Body() dto: PayRemitaBillDto) {
    return this.manualPayments.payRemitaBill(user.id, dto.rrr);
  }

  @Get(':id/remita-status')
  remitaStatus(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.manualPayments.checkRemitaStatus(id, user);
  }

  @Post('lookup')
  lookup(@Body() dto: LookupManualPaymentDto) {
    return this.manualPayments.lookup(dto);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateManualPaymentDto) {
    return this.manualPayments.create(user.id, dto);
  }

  @Get('mine')
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.manualPayments.listMine(user.id);
  }

  @Get(':id/receipt')
  @Header('Content-Type', 'application/pdf')
  @Header('Content-Disposition', 'inline; filename="payder-receipt.pdf"')
  async receipt(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const buffer = await this.manualPayments.getReceiptFile(id, user);
    return new StreamableFile(buffer);
  }
}
