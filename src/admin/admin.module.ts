import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { EmailModule } from '../common/email/email.module';

@Module({
  imports: [EmailModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
