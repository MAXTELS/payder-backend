import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { WithdrawalsService } from './withdrawals.service';
import { RejectWithdrawalDto } from './dto/reject-withdrawal.dto';
import { MarkWithdrawalPaidDto } from './dto/mark-withdrawal-paid.dto';

/**
 * Admin side of the withdrawal queue. Own controller under
 * /admin/withdrawals rather than folded into AdminController — same
 * one-directory-read convention as AdminManualPaymentsController /
 * AdminWalletFundingController.
 */
@Roles('ADMIN')
@Controller('admin/withdrawals')
export class AdminWithdrawalsController {
  constructor(private withdrawals: WithdrawalsService) {}

  @Get()
  queue(@Query('status') status?: string) {
    return this.withdrawals.listQueue(status);
  }

  @Patch(':id/paid')
  markPaid(
    @Param('id') id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: MarkWithdrawalPaidDto,
  ) {
    return this.withdrawals.markPaid(id, admin.id, dto);
  }

  @Patch(':id/reject')
  reject(
    @Param('id') id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: RejectWithdrawalDto,
  ) {
    return this.withdrawals.reject(id, admin.id, dto);
  }
}
