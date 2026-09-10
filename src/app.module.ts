import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { WalletModule } from './wallet/wallet.module';
import { PaymentsModule } from './payments/payments.module';
import { BillsModule } from './bills/bills.module';
import { ExamsModule } from './exams/exams.module';
import { SupportModule } from './support/support.module';
import { AdminModule } from './admin/admin.module';
import { ManualPaymentsModule } from './manual-payments/manual-payments.module';
import { WalletFundingModule } from './wallet-funding/wallet-funding.module';
import { KycModule } from './kyc/kyc.module';
import { WithdrawalsModule } from './withdrawals/withdrawals.module';
import { BillersModule } from './billers/billers.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    PrismaModule,
    AuthModule,
    UsersModule,
    WalletModule,
    PaymentsModule,
    BillsModule,
    ExamsModule,
    SupportModule,
    AdminModule,
    ManualPaymentsModule,
    WalletFundingModule,
    KycModule,
    WithdrawalsModule,
    BillersModule,
  ],
})
export class AppModule {}
