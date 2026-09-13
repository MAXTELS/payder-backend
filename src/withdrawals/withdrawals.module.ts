import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { WithdrawalsController } from './withdrawals.controller';
import { AdminWithdrawalsController } from './admin-withdrawals.controller';
import { WithdrawalsService } from './withdrawals.service';
import { WalletModule } from '../wallet/wallet.module';
import { BillerWalletModule } from '../billers/biller-wallet.module';
import { EmailModule } from '../common/email/email.module';
import { AdminNotificationModule } from '../admin-notifications/admin-notification.module';

@Module({
  imports: [WalletModule, BillerWalletModule, EmailModule, HttpModule, AdminNotificationModule],
  controllers: [WithdrawalsController, AdminWithdrawalsController],
  providers: [WithdrawalsService],
  exports: [WithdrawalsService],
})
export class WithdrawalsModule {}
