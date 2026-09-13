import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BillsController } from './bills.controller';
import { BillsService } from './bills.service';
import { VtpassProvider } from './providers/vtpass.provider';
import { PairgateVtuProvider } from './providers/pairgate-vtu.provider';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [HttpModule, WalletModule],
  controllers: [BillsController],
  // VtpassProvider stays registered (rollback path — see
  // BillsService's constructor comment) even though nothing calls it
  // anymore. BillsService exported too, 2026-09-13, so the new generic
  // Pairgate webhook module (backend/src/webhooks/pairgate-webhook.*) can
  // resolve a PROCESSING electricity purchase's token.
  providers: [BillsService, VtpassProvider, PairgateVtuProvider],
  exports: [VtpassProvider, PairgateVtuProvider, BillsService],
})
export class BillsModule {}
