import { Module } from '@nestjs/common';
import { WalletFundingController } from './wallet-funding.controller';
import { AdminWalletFundingController } from './admin-wallet-funding.controller';
import { WalletFundingService } from './wallet-funding.service';
import { WalletModule } from '../wallet/wallet.module';
import { EmailModule } from '../common/email/email.module';
import { AdminNotificationModule } from '../admin-notifications/admin-notification.module';

@Module({
  imports: [WalletModule, EmailModule, AdminNotificationModule],
  controllers: [WalletFundingController, AdminWalletFundingController],
  providers: [WalletFundingService],
})
export class WalletFundingModule {}
