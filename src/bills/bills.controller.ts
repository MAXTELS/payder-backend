import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { BillsService } from './bills.service';
import { PurchaseDto } from './dto/purchase.dto';

@Controller('bills')
export class BillsController {
  constructor(private billsService: BillsService) {}

  // Data bundle plans / TV bouquets for a given serviceId (e.g. "mtn-data",
  // "gotv") — live from VTpass, so sandbox vs live pricing/plans are always
  // whatever VTpass actually has right now.
  @Get('variations')
  variations(@Query('serviceId') serviceId: string) {
    return this.billsService.listVariations(serviceId);
  }

  @Get('verify')
  verify(@Query('serviceId') serviceId: string, @Query('customerId') customerId: string) {
    return this.billsService.verifyCustomer(serviceId, customerId);
  }

  @Post('purchase')
  purchase(@CurrentUser() user: AuthenticatedUser, @Body() dto: PurchaseDto) {
    // Client should generate and send its own idempotency key in production
    // (header, not shown here) so a retried request from a flaky mobile
    // network never double-charges. Left simple for the scaffold.
    const idempotencyKey = `${user.id}:${dto.serviceId}:${dto.customerId}:${Date.now()}`;
    return this.billsService.purchase(user.id, dto, idempotencyKey);
  }

  // Polled by the client while a purchase is PROCESSING — see
  // BillsService.checkStatus.
  @Get(':id/status')
  status(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.billsService.checkStatus(user.id, id);
  }
}
