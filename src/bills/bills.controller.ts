import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { BillsService } from './bills.service';
import { PurchaseDto } from './dto/purchase.dto';
import { VtuCategory } from './providers/vtu-provider.interface';

@Controller('bills')
export class BillsController {
  constructor(private billsService: BillsService) {}

  // Data bundle plans / TV bouquets for a given serviceId (e.g. "mtn-data",
  // "gotv") — live from Pairgate, so sandbox vs live pricing/plans are
  // always whatever Pairgate actually has right now. `category` is required
  // since 2026-09-13's Pairgate migration (see
  // vtu-provider.interface.ts's header comment for why).
  @Get('variations')
  variations(@Query('serviceId') serviceId: string, @Query('category') category: VtuCategory) {
    return this.billsService.listVariations(serviceId, category);
  }

  // New 2026-09-13, alongside the Pairgate migration — electricity has no
  // pre-existing serviceId list in this app (VTpass never implemented it),
  // so the frontend needs this to populate a DISCO picker. Also usable for
  // airtime/data/tv if a live provider dropdown is ever wanted there
  // instead of the app's current hardcoded lists.
  @Get('providers')
  providers(@Query('category') category: VtuCategory) {
    return this.billsService.listProviders(category);
  }

  @Get('verify')
  verify(
    @Query('serviceId') serviceId: string,
    @Query('customerId') customerId: string,
    @Query('category') category?: VtuCategory,
    @Query('meterType') meterType?: string,
  ) {
    // Query params always arrive as strings — meterType needs coercing to
    // the 1|2 the provider layer expects.
    const parsedMeterType = meterType ? ((Number(meterType) as 1 | 2) ?? undefined) : undefined;
    return this.billsService.verifyCustomer(serviceId, customerId, category, parsedMeterType);
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
