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
  exports: [PairgateProvider],
})
export class BettingModule {}
