import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
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
import { BillerPaymentsModule } from './biller-payments/biller-payments.module';
import { BettingModule } from './betting/betting.module';
import { PairgateWebhookModule } from './webhooks/pairgate-webhook.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    // Powers BillerReportsCron's @Cron midnight report-email job (see
    // biller-feature-spec.md). Needs `@nestjs/schedule` installed —
    // added to package.json, run `npm install`.
    ScheduleModule.forRoot(),
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
    BillerPaymentsModule,
    BettingModule,
    PairgateWebhookModule,
  ],
})
export class AppModule {}
