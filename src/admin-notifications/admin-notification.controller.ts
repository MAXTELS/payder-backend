import { Body, Controller, Get, Patch } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { AdminNotificationService } from './admin-notification.service';

// Backs the admin dashboard's "Notification emails" settings section —
// which categories of admin-approval-needed events get emailed, and to
// which manually-entered address(es). See AdminNotificationService's header
// comment for the full design.
@Roles('ADMIN')
@Controller('admin/notification-settings')
export class AdminNotificationController {
  constructor(private service: AdminNotificationService) {}

  @Get()
  get() {
    return this.service.getSettings();
  }

  @Patch()
  update(@Body('categories') categories: string[] = [], @Body('emails') emails: string[] = []) {
    return this.service.updateSettings(categories, emails);
  }
}
