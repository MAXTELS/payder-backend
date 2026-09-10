import { Module } from '@nestjs/common';
import { ExamsController } from './exams.controller';
import { ExamsService } from './exams.service';
import { BillsModule } from '../bills/bills.module';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [BillsModule, WalletModule],
  controllers: [ExamsController],
  providers: [ExamsService],
})
export class ExamsModule {}
