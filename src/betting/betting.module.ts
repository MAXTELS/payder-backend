import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BettingController } from './betting.controller';
import { BettingService } from './betting.service';
import { PairgateProvider } from './providers/pairgate.provider';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [HttpModule, WalletModule],
  controllers: [BettingController],
  providers: [BettingService, PairgateProvider],
  // BettingService exported too, 2026-09-13, so the new generic Pairgate
  // webhook module (backend/src/webhooks/pairgate-webhook.*) can resolve a
  // PROCESSING betting funding when Pairgate's webhook confirms it.
  exports: [PairgateProvider, BettingService],
})
export class BettingModule {}
