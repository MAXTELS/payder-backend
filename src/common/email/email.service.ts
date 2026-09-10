import { Injectable, Logger } from '@nestjs/common';

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  attachments?: { filename: string; content: Buffer }[];
}

/**
 * Email delivery is stubbed, same as OTP delivery in AuthService — no
 * SendGrid/Postmark account is wired up yet (see architecture doc §5.6).
 * Every call is logged so the calling code (receipt emails, future OTP,
 * ticket notifications) can be written and tested now, and swapped to a real
 * provider later without touching any caller.
 *
 * TODO: replace this body with a real SendGrid/Postmark client once a
 * provider is chosen, reading credentials from the secrets manager (§8), not
 * from .env.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  async send(email: OutboundEmail): Promise<{ delivered: false; stubbed: true }> {
    this.logger.log(
      `[stub] would send email to=${email.to} subject="${email.subject}" ` +
        `attachments=${email.attachments?.map((a) => a.filename).join(',') ?? 'none'}`,
    );
    return { delivered: false, stubbed: true };
  }
}
