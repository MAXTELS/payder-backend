import { Module } from '@nestjs/common';
import { PairgateWebhookController } from './pairgate-webhook.controller';
import { PairgateWebhookService } from './pairgate-webhook.service';
import { WalletModule } from '../wallet/wallet.module';
import { BillsModule } from '../bills/bills.module';
import { ExamsModule } from '../exams/exams.module';
import { BettingModule } from '../betting/betting.module';

@Module({
  imports: [WalletModule, BillsModule, ExamsModule, BettingModule],
  controllers: [PairgateWebhookController],
  providers: [PairgateWebhookService],
})
export class PairgateWebhookModule {}
