import { Module } from '@nestjs/common';
import { EmailModule } from '../common/email/email.module';
import { AdminNotificationService } from './admin-notification.service';
import { AdminNotificationController } from './admin-notification.controller';

@Module({
  imports: [EmailModule],
  controllers: [AdminNotificationController],
  providers: [AdminNotificationService],
  exports: [AdminNotificationService],
})
export class AdminNotificationModule {}
