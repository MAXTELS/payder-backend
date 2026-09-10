import { Module } from '@nestjs/common';
import { KycController } from './kyc.controller';
import { KycService } from './kyc.service';
import { EmailModule } from '../common/email/email.module';
import { SmsModule } from '../common/sms/sms.module';
import { CryptoModule } from '../common/crypto/crypto.module';

@Module({
  imports: [EmailModule, SmsModule, CryptoModule],
  controllers: [KycController],
  providers: [KycService],
})
export class KycModule {}
