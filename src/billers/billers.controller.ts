import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { BillersService } from './billers.service';
import { SetBillerPinDto } from './dto/set-biller-pin.dto';
import { BillerWithdrawDto } from './dto/biller-withdraw.dto';
import { ApproveBillerWithdrawalDto } from './dto/approve-biller-withdrawal.dto';

/**
 * Everything a logged-in BILLER-role user can do for their own biller.
 * Phase 1 only — wallet balance/history + the dual-approval withdrawal flow.
 * The bill builder (GET/PUT /billers/bill, publish) and deposit are phase 2
 * — see biller-feature-spec.md.
 */
@Roles('BILLER')
@Controller('billers')
export class BillersController {
  constructor(private billers: BillersService) {}

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.billers.getMe(user.id);
  }

  @Post('pin')
  setPin(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetBillerPinDto) {
    return this.billers.setPin(user.id, dto);
  }

  @Get('wallet/balance')
  balance(@CurrentUser() user: AuthenticatedUser) {
    return this.billers.getBalance(user.id);
  }

  @Get('wallet/statement')
  statement(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const parsedLimit = limit ? Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100) : 20;
    return this.billers.getStatement(user.id, { limit: parsedLimit, cursor });
  }

  @Post('wallet/withdraw')
  withdraw(@CurrentUser() user: AuthenticatedUser, @Body() dto: BillerWithdrawDto) {
    return this.billers.initiateWithdrawal(user.id, dto);
  }

  @Get('wallet/withdraw/drafts')
  drafts(@CurrentUser() user: AuthenticatedUser) {
    return this.billers.listDrafts(user.id);
  }

  @Post('wallet/withdraw/drafts/:id/approve')
  approveDraft(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ApproveBillerWithdrawalDto,
  ) {
    return this.billers.approveDraft(user.id, id, dto);
  }

  @Post('wallet/withdraw/drafts/:id/cancel')
  cancelDraft(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.billers.cancelDraft(user.id, id);
  }

  @Get('wallet/withdrawals/mine')
  withdrawals(@CurrentUser() user: AuthenticatedUser) {
    return this.billers.listWithdrawals(user.id);
  }
}
