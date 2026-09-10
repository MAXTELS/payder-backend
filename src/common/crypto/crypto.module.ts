import { Module } from '@nestjs/common';
import { PiiEncryptionService } from './pii-encryption.service';

@Module({
  providers: [PiiEncryptionService],
  exports: [PiiEncryptionService],
})
export class CryptoModule {}
