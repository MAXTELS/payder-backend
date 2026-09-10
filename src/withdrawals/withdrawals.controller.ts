import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { WithdrawalsService } from './withdrawals.service';
import { CreateWithdrawalDto } from './dto/create-withdrawal.dto';

/**
 * Customer-facing side of withdrawals: see the NGN bank list, submit a
 * request (debits the wallet immediately — see WithdrawalsService), track
 * status. Payout itself is admin-reviewed — see AdminWithdrawalsController.
 */
@Controller('withdrawals')
export class WithdrawalsController {
  constructor(private withdrawals: WithdrawalsService) {}

  @Get('banks')
  banks() {
    return this.withdrawals.listBanks();
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateWithdrawalDto) {
    return this.withdrawals.create(user.id, dto);
  }

  @Get('mine')
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.withdrawals.listMine(user.id);
  }
}
