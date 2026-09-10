import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { WalletFundingService } from './wallet-funding.service';
import { CreateWalletFundingDto } from './dto/create-wallet-funding.dto';

/**
 * Customer-facing side of manual bank-transfer wallet funding: see the
 * static account numbers, tell us "I have paid", track status. Nothing here
 * touches the ledger — see WalletFundingService for why.
 */
@Controller('wallet-funding')
export class WalletFundingController {
  constructor(private walletFunding: WalletFundingService) {}

  @Get('destinations')
  destinations() {
    return this.walletFunding.destinations();
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateWalletFundingDto) {
    return this.walletFunding.create(user.id, dto);
  }

  @Get('mine')
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.walletFunding.listMine(user.id);
  }
}
