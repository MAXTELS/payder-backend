import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { BillerWalletService } from './biller-wallet.service';

/**
 * Standalone module (no controllers) so both WithdrawalsModule and
 * BillersModule can import it without a circular dependency —
 * WithdrawalsService needs BillerWalletService, and BillersService needs
 * WithdrawalsService, so BillerWalletService can't live inside
 * BillersModule itself. See biller-feature-spec.md.
 */
@Module({
  imports: [WalletModule], // for LedgerService
  providers: [BillerWalletService],
  exports: [BillerWalletService],
})
export class BillerWalletModule {}
