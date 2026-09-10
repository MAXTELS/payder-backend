import { Module } from '@nestjs/common';
import { AdminBillersController } from './admin-billers.controller';
import { BillersController } from './billers.controller';
import { BillersAdminService } from './billers-admin.service';
import { BillersService } from './billers.service';
import { BillerWalletModule } from './biller-wallet.module';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module';
import { EmailModule } from '../common/email/email.module';
import { CryptoModule } from '../common/crypto/crypto.module';
import { SupportModule } from '../support/support.module';
import { PaymentsModule } from '../payments/payments.module';
import { BillerReportsCron } from './biller-reports.cron';

@Module({
  imports: [
    BillerWalletModule,
    WithdrawalsModule,
    EmailModule,
    CryptoModule,
    SupportModule, // for the "request bill edit" support ticket
    PaymentsModule, // for PaystackProvider (wallet deposit + used by BillerPaymentsModule)
  ],
  controllers: [AdminBillersController, BillersController],
  providers: [BillersAdminService, BillersService, BillerReportsCron],
  exports: [BillersService],
})
export class BillersModule {}
