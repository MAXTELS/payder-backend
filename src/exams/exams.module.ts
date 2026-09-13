import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ExamsController } from './exams.controller';
import { ExamsService } from './exams.service';
import { PairgateEducationProvider } from './providers/pairgate-education.provider';
import { BillsModule } from '../bills/bills.module';
import { WalletModule } from '../wallet/wallet.module';
import { EmailModule } from '../common/email/email.module';

// BillsModule import stays (ExamsService still injects VtpassProvider for
// JAMB, which Pairgate's education category doesn't offer — see
// ExamsService's header comment). HttpModule is new here — needed for
// PairgateEducationProvider's own HttpService, same as BillsModule/
// BettingModule each import it for their own Pairgate-backed providers.
@Module({
  imports: [BillsModule, WalletModule, EmailModule, HttpModule],
  controllers: [ExamsController],
  providers: [ExamsService, PairgateEducationProvider],
  // ExamsService exported, 2026-09-13, so the new generic Pairgate webhook
  // module (backend/src/webhooks/pairgate-webhook.*) can resolve a
  // PROCESSING WAEC/NECO purchase's pin.
  exports: [ExamsService],
})
export class ExamsModule {}
