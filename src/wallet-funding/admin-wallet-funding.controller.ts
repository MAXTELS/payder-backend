import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { WalletFundingService } from './wallet-funding.service';
import { RejectWalletFundingDto } from './dto/reject-wallet-funding.dto';

/**
 * Admin side of the manual bank-transfer funding queue. Kept as its own
 * controller under /admin/wallet-funding rather than folded into
 * AdminController — same "one directory read" convention as
 * AdminManualPaymentsController.
 */
@Roles('ADMIN')
@Controller('admin/wallet-funding')
export class AdminWalletFundingController {
  constructor(private walletFunding: WalletFundingService) {}

  @Get()
  queue(@Query('status') status?: string) {
    return this.walletFunding.listQueue(status);
  }

  @Patch(':id/approve')
  approve(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser) {
    return this.walletFunding.approve(id, admin.id);
  }

  @Patch(':id/reject')
  reject(
    @Param('id') id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: RejectWalletFundingDto,
  ) {
    return this.walletFunding.reject(id, admin.id, dto);
  }
}
