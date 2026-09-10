import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../common/email/email.service';
import { BillersService } from './billers.service';

/**
 * Midnight report email — "once there's a payment, let the email be sent by
 * 12am to the biller of the previous day's payment report for receipts."
 * Frequency (DAILY/WEEKLY/EVERY_3_DAYS/OFF) is per BILLER USER, not per
 * biller — see BillerReportPreference schema comment; a joint biller's A and
 * B each get emailed on their own chosen cadence.
 *
 * Requires `@nestjs/schedule` (added to package.json — run `npm install`)
 * and `ScheduleModule.forRoot()` in AppModule for @Cron to actually fire.
 */
@Injectable()
export class BillerReportsCron {
  private readonly logger = new Logger(BillerReportsCron.name);

  constructor(
    private prisma: PrismaService,
    private email: EmailService,
    private billers: BillersService,
  ) {}

  @Cron('0 0 * * *') // every day at 00:00 server time
  async sendDueReports() {
    const preferences = await this.prisma.billerReportPreference.findMany({
      where: { frequency: { not: 'OFF' } },
      include: { user: true, biller: true },
    });

    for (const pref of preferences) {
      if (!this.isDue(pref.frequency, pref.lastSentAt)) continue;

      try {
        const { csv, date } = await this.billers.dailyReportCsv(pref.userId);
        if (!csv) {
          // No payments in the covered period — spec only promises a report
          // "once there's a payment", so silently skip rather than email an
          // empty attachment. lastSentAt is deliberately NOT updated here,
          // so a quiet day doesn't push the next real report further out.
          continue;
        }

        await this.email.send({
          to: pref.user.email,
          subject: `PAYDER — ${pref.biller.name} payment report (${date})`,
          text:
            `Hi ${pref.user.firstName},\n\nAttached is the payment report for "${pref.biller.name}" ` +
            `for ${date}. Use it to write receipts for the day's payers.\n\n` +
            `You can change how often you receive this (or turn it off) from your biller portal.`,
          attachments: [{ filename: `payments-${date}.csv`, content: Buffer.from(csv, 'utf-8') }],
        });

        await this.prisma.billerReportPreference.update({
          where: { id: pref.id },
          data: { lastSentAt: new Date() },
        });
      } catch (err) {
        this.logger.error(
          `Failed to send report to biller-user ${pref.userId}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }

  private isDue(frequency: string, lastSentAt: Date | null): boolean {
    if (!lastSentAt) return true;
    const msSince = Date.now() - lastSentAt.getTime();
    const DAY = 24 * 60 * 60 * 1000;
    // Small grace window so a job that runs a minute early/late each night
    // doesn't skip a day.
    const GRACE = 5 * 60 * 1000;
    switch (frequency) {
      case 'DAILY':
        return msSince >= DAY - GRACE;
      case 'WEEKLY':
        return msSince >= 7 * DAY - GRACE;
      case 'EVERY_3_DAYS':
        return msSince >= 3 * DAY - GRACE;
      default:
        return false;
    }
  }
}
