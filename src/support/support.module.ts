import { Module } from '@nestjs/common';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';
import { AdminNotificationModule } from '../admin-notifications/admin-notification.module';

@Module({
  imports: [AdminNotificationModule],
  controllers: [SupportController],
  providers: [SupportService],
  // Exported so BillersModule can reuse createTicket() for the "request bill
  // edit" flow (see biller-feature-spec.md) without duplicating ticket logic.
  exports: [SupportService],
})
export class SupportModule {}
