import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  // Optional designed version of the same message (see email-template.ts) —
  // when set, SendGrid is given BOTH text/plain (text above, as a fallback
  // for clients that don't render HTML) and text/html, same as any normal
  // multipart marketing/transactional email.
  html?: string;
  attachments?: { filename: string; content: Buffer }[];
}

/**
 * Sends via SendGrid's v3 Mail Send API when SENDGRID_API_KEY is configured
 * (a plain REST call over the HttpService already used elsewhere in this
 * app, rather than pulling in the @sendgrid/mail package — one less
 * dependency to install for the same result). Falls back to the original
 * stub behavior (log-only, `delivered: false`) when no key is set, so local
 * dev without SendGrid credentials still works exactly as before and every
 * caller (OTP codes, receipts, ticket notifications) keeps working
 * end-to-end either way — only the delivery outcome differs.
 *
 * EMAIL_FROM must be a sender SendGrid has verified for this account (either
 * a verified single sender or a domain with domain authentication set up) —
 * SendGrid rejects the send otherwise. See backend/.env.example.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private http: HttpService,
    private config: ConfigService,
  ) {}

  async send(email: OutboundEmail): Promise<{ delivered: boolean; stubbed: boolean }> {
    const apiKey = this.config.get<string>('SENDGRID_API_KEY');
    const from = this.config.get<string>('EMAIL_FROM');

    if (!apiKey || apiKey === 'replace-me') {
      this.logger.log(
        `[stub] would send email to=${email.to} subject="${email.subject}" ` +
          `attachments=${email.attachments?.map((a) => a.filename).join(',') ?? 'none'}`,
      );
      return { delivered: false, stubbed: true };
    }

    if (!from) {
      // Misconfiguration, not a delivery failure — fail loudly in the logs
      // rather than silently pretending to have sent something SendGrid
      // would reject anyway.
      this.logger.error('SENDGRID_API_KEY is set but EMAIL_FROM is missing — cannot send email');
      return { delivered: false, stubbed: false };
    }

    try {
      await firstValueFrom(
        this.http.post(
          'https://api.sendgrid.com/v3/mail/send',
          {
            personalizations: [{ to: [{ email: email.to }] }],
            from: { email: from },
            subject: email.subject,
            // SendGrid requires text/plain before text/html when both are
            // present, in that order, in the content array.
            content: [
              { type: 'text/plain', value: email.text },
              ...(email.html ? [{ type: 'text/html', value: email.html }] : []),
            ],
            ...(email.attachments?.length
              ? {
                  attachments: email.attachments.map((a) => ({
                    filename: a.filename,
                    content: a.content.toString('base64'),
                  })),
                }
              : {}),
          },
          { headers: { Authorization: `Bearer ${apiKey}` } },
        ),
      );
      return { delivered: true, stubbed: false };
    } catch (err: any) {
      // A bad/unverified sender, an invalid recipient, or a SendGrid outage
      // shouldn't crash whatever flow triggered the email (e.g. OTP request)
      // — log it and let the caller treat this the same as "not delivered".
      const detail = err?.response?.data ?? err?.message ?? err;
      this.logger.error(`SendGrid send to ${email.to} failed: ${JSON.stringify(detail)}`);
      return { delivered: false, stubbed: false };
    }
  }
}
