import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaystackProvider } from './providers/paystack.provider';
import { FlutterwaveProvider } from './providers/flutterwave.provider';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [HttpModule, WalletModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaystackProvider, FlutterwaveProvider],
  exports: [PaystackProvider, FlutterwaveProvider],
})
export class PaymentsModule {}
