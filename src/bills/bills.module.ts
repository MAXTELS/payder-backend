import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BillsController } from './bills.controller';
import { BillsService } from './bills.service';
import { VtpassProvider } from './providers/vtpass.provider';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [HttpModule, WalletModule],
  controllers: [BillsController],
  providers: [BillsService, VtpassProvider],
  exports: [VtpassProvider],
})
export class BillsModule {}
