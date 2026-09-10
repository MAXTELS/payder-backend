import { Module } from '@nestjs/common';
import { AdminBillersController } from './admin-billers.controller';
import { BillersController } from './billers.controller';
import { BillersAdminService } from './billers-admin.service';
import { BillersService } from './billers.service';
import { BillerWalletModule } from './biller-wallet.module';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module';
import { EmailModule } from '../common/email/email.module';
import { CryptoModule } from '../common/crypto/crypto.module';

@Module({
  imports: [BillerWalletModule, WithdrawalsModule, EmailModule, CryptoModule],
  controllers: [AdminBillersController, BillersController],
  providers: [BillersAdminService, BillersService],
})
export class BillersModule {}
