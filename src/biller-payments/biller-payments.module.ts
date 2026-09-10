import { Module } from '@nestjs/common';
import { BillerPaymentsController } from './biller-payments.controller';
import { BillerPaymentsService } from './biller-payments.service';
import { WalletModule } from '../wallet/wallet.module';
import { BillerWalletModule } from '../billers/biller-wallet.module';
import { PaymentsModule } from '../payments/payments.module';

/**
 * Separate from BillersModule on purpose — this is the customer/guest-facing
 * side of the feature (browsing + paying a bill), not the biller's own
 * management of it, and keeping them apart avoids yet another
 * BillersModule <-> withdrawals/payments import cycle.
 */
@Module({
  imports: [WalletModule, BillerWalletModule, PaymentsModule],
  controllers: [BillerPaymentsController],
  providers: [BillerPaymentsService],
})
export class BillerPaymentsModule {}
