import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ManualPaymentsController } from './manual-payments.controller';
import { AdminManualPaymentsController } from './admin-manual-payments.controller';
import { ManualPaymentsService } from './manual-payments.service';
import { ReceiptService } from './receipt.service';
import { RemitaProvider } from './remita.provider';
import { WalletModule } from '../wallet/wallet.module';
import { EmailModule } from '../common/email/email.module';

@Module({
  imports: [WalletModule, EmailModule, HttpModule],
  controllers: [ManualPaymentsController, AdminManualPaymentsController],
  providers: [ManualPaymentsService, ReceiptService, RemitaProvider],
})
export class ManualPaymentsModule {}
