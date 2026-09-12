import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { EmailModule } from '../common/email/email.module';
import { CryptoModule } from '../common/crypto/crypto.module';

@Module({
  imports: [EmailModule, CryptoModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
