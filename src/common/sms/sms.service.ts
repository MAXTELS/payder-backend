import { Injectable, Logger } from '@nestjs/common';

/**
 * SMS delivery is stubbed, same pattern as EmailService — no Termii account
 * is wired up yet (TERMII_API_KEY is a placeholder in .env). Every call is
 * logged so OTP-over-phone can be written and tested now, and swapped to a
 * real provider later without touching any caller.
 *
 * TODO: replace this body with a real Termii client once credentials exist,
 * reading them from the secrets manager (§8), not from .env.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  async send(to: string, message: string): Promise<{ delivered: false; stubbed: true }> {
    this.logger.log(`[stub] would SMS to=${to} message="${message}"`);
    return { delivered: false, stubbed: true };
  }
}
