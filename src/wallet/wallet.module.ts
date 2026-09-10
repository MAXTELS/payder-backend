import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { LedgerService } from './ledger.service';

@Module({
  controllers: [WalletController],
  providers: [WalletService, LedgerService],
  exports: [WalletService, LedgerService],
})
export class WalletModule {}
