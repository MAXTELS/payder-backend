import { Module } from '@nestjs/common';
import { ExamsController } from './exams.controller';
import { ExamsService } from './exams.service';
import { BillsModule } from '../bills/bills.module';
import { WalletModule } from '../wallet/wallet.module';
import { EmailModule } from '../common/email/email.module';

@Module({
  imports: [BillsModule, WalletModule, EmailModule],
  controllers: [ExamsController],
  providers: [ExamsService],
})
export class ExamsModule {}
