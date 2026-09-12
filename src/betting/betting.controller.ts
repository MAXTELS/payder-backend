import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { BettingService } from './betting.service';
import { FundBettingDto } from './dto/fund-betting.dto';

@Controller('betting')
export class BettingController {
  constructor(private bettingService: BettingService) {}

  @Get('providers')
  listProviders() {
    return this.bettingService.listProviders();
  }

  @Get('verify')
  verify(@Query('providerId') providerId: string, @Query('customerId') customerId: string) {
    return this.bettingService.verifyCustomer(providerId, customerId);
  }

  @Post('fund')
  fund(@CurrentUser() user: AuthenticatedUser, @Body() dto: FundBettingDto) {
    // Same scaffold-simple idempotency key as BillsController.purchase —
    // see that file's comment on generating a real client-side key later.
    const idempotencyKey = `${user.id}:${dto.providerId}:${dto.customerId}:${Date.now()}`;
    return this.bettingService.fund(user.id, dto, idempotencyKey);
  }

  // Mirrors BillsController's status route — lets the client poll a
  // PROCESSING funding request until Pairgate resolves it one way or the
  // other (see BettingService.checkStatus).
  @Get(':id/status')
  checkStatus(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.bettingService.checkStatus(user.id, id);
  }
}
