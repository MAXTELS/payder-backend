import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../common/email/email.service';
import { renderEmailHtml, paragraphHtml } from '../common/email/email-template';

// 2026-09-13, per Jude's request: admins get emailed about things that need
// their approval, instead of only seeing them in the dashboard queue.
// Configured from the admin dashboard as a single global settings row (not
// per-admin — see AdminNotificationSettings' schema comment) with a
// category checklist and one or more manually-entered email addresses
// (deliberately not tied to any admin's own login email — e.g. a shared
// ops inbox).
export const NOTIFICATION_CATEGORIES = [
  'PENDING_TRANSACTIONS',
  'WITHDRAWALS',
  'SUPPORT',
  'ALL',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

const SETTINGS_ID = 'singleton';

@Injectable()
export class AdminNotificationService {
  private readonly logger = new Logger(AdminNotificationService.name);

  constructor(
    private prisma: PrismaService,
    private email: EmailService,
  ) {}

  async getSettings() {
    const row = await this.prisma.adminNotificationSettings.upsert({
      where: { id: SETTINGS_ID },
      update: {},
      create: { id: SETTINGS_ID, categories: [], emails: [] },
    });
    return { categories: row.categories, emails: row.emails };
  }

  async updateSettings(categories: string[], emails: string[]) {
    const invalid = categories.filter((c) => !(NOTIFICATION_CATEGORIES as readonly string[]).includes(c));
    if (invalid.length > 0) {
      throw new BadRequestException(`Unknown notification category: ${invalid.join(', ')}`);
    }
    const cleanedEmails = emails.map((e) => e.trim()).filter(Boolean);
    for (const e of cleanedEmails) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
        throw new BadRequestException(`"${e}" doesn't look like a valid email address`);
      }
    }
    const row = await this.prisma.adminNotificationSettings.upsert({
      where: { id: SETTINGS_ID },
      update: { categories, emails: cleanedEmails },
      create: { id: SETTINGS_ID, categories, emails: cleanedEmails },
    });
    return { categories: row.categories, emails: row.emails };
  }

  /**
   * Fire-and-forget notification for one category — called from wherever a
   * transaction/request/ticket first becomes something an admin needs to
   * act on (WalletFundingService.create, WithdrawalsService.create/
   * createForBiller, ManualPaymentsService.create, SupportService.createTicket).
   * Sends to every configured email if `category` is explicitly enabled OR
   * 'ALL' is enabled. Never throws — a notification failure must never
   * block the actual money-moving/ticket-creating action that triggered it
   * (same "EmailService never throws" convention used everywhere else in
   * this app, just enforced here too since this wraps a settings lookup on
   * top of that).
   */
  async notify(category: Exclude<NotificationCategory, 'ALL'>, subject: string, bodyText: string) {
    try {
      const settings = await this.getSettings();
      const enabled = settings.categories.includes(category) || settings.categories.includes('ALL');
      if (!enabled || settings.emails.length === 0) return;

      await Promise.all(
        settings.emails.map((to) =>
          this.email.send({
            to,
            subject: `PAYDER admin — ${subject}`,
            text: bodyText,
            html: renderEmailHtml({
              heading: subject,
              bodyHtml: paragraphHtml(bodyText.replace(/\n/g, '<br/>')),
            }),
          }),
        ),
      );
    } catch (err) {
      this.logger.error(
        `AdminNotificationService.notify(${category}) failed`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
