import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomInt, randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../common/email/email.service';
import { renderEmailHtml, paragraphHtml, pinBoxHtml } from '../common/email/email-template';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyDeviceDto } from './dto/verify-device.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

const PASSWORD_RESET_OTP_TTL_MINUTES = 15;
const PASSWORD_RESET_OTP_PURPOSE = 'PASSWORD_RESET';

// 2026-09-13: single-active-mobile-device feature (see User.activeMobileDeviceId
// /tokenVersion schema comments). Mobile-only — a login with no `deviceId` in
// the DTO (i.e. web) never goes near this at all.
const DEVICE_VERIFICATION_OTP_TTL_MINUTES = 10;
const DEVICE_VERIFICATION_OTP_PURPOSE = 'MOBILE_DEVICE_VERIFICATION';
const DEVICE_VERIFICATION_MESSAGE =
  "We've emailed you a code to confirm it's you — your account is still logged in on another phone.";

/**
 * Auth v0: password + JWT access/refresh. OTP delivery (SMS/email) and
 * refresh-token-reuse detection are stubbed with TODOs pointing at where the
 * real provider calls (Termii/SendGrid) and a persisted refresh-token-family
 * table need to land — see architecture doc §8.
 */
@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private email: EmailService,
  ) {}

  async register(dto: RegisterDto) {
    // TEMP diagnostic capture — remove once the register() 500 is root-caused.
    // Wraps the whole method (not just the DB transaction) since bcrypt.hash
    // or the initial findFirst could just as easily be the actual throw site,
    // and NestJS swallows the real error behind a generic 500 response.
    try {
      return await this.registerInner(dto);
    } catch (err: any) {
      try {
        writeFileSync(
          join(process.cwd(), 'register-error.json'),
          JSON.stringify(
            { message: err?.message, name: err?.name, code: err?.code, meta: err?.meta, stack: err?.stack },
            null,
            2,
          ),
        );
      } catch {
        // ignore
      }
      throw err;
    }
  }

  private async registerInner(dto: RegisterDto) {
    // Email is case-insensitive everywhere a person types it (login, this
    // dedupe check, password reset) — normalize to lowercase once here so
    // every row written from this point on is consistent, and match
    // case-insensitively below so an existing mixed-case row (from before
    // this normalization existed) still gets caught as a duplicate.
    const normalizedEmail = dto.email.trim().toLowerCase();

    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: { equals: normalizedEmail, mode: 'insensitive' } }, { phone: dto.phone }],
      },
    });
    if (existing) {
      throw new ConflictException('An account with this email or phone already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);

    // User + wallet + ledger account are created together in one transaction
    // so a mid-way failure can never leave a user without a wallet (or vice
    // versa). Wallet is created before LedgerAccount because the FK actually
    // lives on ledger_accounts.wallet_id (LedgerAccount owns the 1:1 relation
    // per schema.prisma) — connecting in this order writes the FK directly
    // instead of relying on Prisma's non-owning-side nested connect.
    const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email: normalizedEmail,
            phone: dto.phone,
            firstName: dto.firstName,
            lastName: dto.lastName,
            passwordHash,
          },
        });

        // Create the wallet + its ledger account up front so every user has
        // somewhere for money to land as soon as KYC/funding allows.
        const wallet = await tx.wallet.create({
          data: { userId: created.id },
        });
        await tx.ledgerAccount.create({
          data: { name: `user:${created.id}`, wallet: { connect: { id: wallet.id } } },
        });

        return created;
      });

    // TODO: send OTP via Termii (SMS) + SendGrid (email) and require
    // verification before the account is usable for anything money-moving.

    return { id: user.id, email: user.email, phone: user.phone };
  }

  async login(dto: LoginDto) {
    // The identifier is either an email or a phone number — emails should
    // never be case-sensitive to type (nobody remembers whether they signed
    // up as "Jude@" or "jude@"), so match email case-insensitively. `mode:
    // 'insensitive'` also covers any pre-existing row that predates
    // registerInner's lowercase normalization above.
    const identifier = dto.identifier.trim();
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: { equals: identifier, mode: 'insensitive' } }, { phone: identifier }],
      },
    });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const passwordOk = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordOk) throw new UnauthorizedException('Invalid credentials');

    if (!user.isActive) throw new UnauthorizedException('Account is suspended');

    // Single-active-mobile-device check — only when the caller sent a
    // deviceId (mobile) AND the account already has a DIFFERENT device
    // marked active (i.e. someone is/was logged in on another phone and
    // never explicitly logged out). Same device re-logging in, or no
    // device currently active (first-ever mobile login, or after an
    // explicit logout), proceeds normally.
    if (dto.deviceId && user.activeMobileDeviceId && user.activeMobileDeviceId !== dto.deviceId) {
      await this.sendDeviceVerificationCode(user.id, user.email, user.firstName);
      return { requiresDeviceVerification: true, message: DEVICE_VERIFICATION_MESSAGE };
    }

    if (dto.deviceId && user.activeMobileDeviceId !== dto.deviceId) {
      // First mobile login, or re-establishing after an explicit logout —
      // claim this device as the active one, no verification needed.
      await this.prisma.user.update({
        where: { id: user.id },
        data: { activeMobileDeviceId: dto.deviceId },
      });
    }

    return this.issueTokens(user.id, user.role, user.kycTier, user.tokenVersion, dto.deviceId ? 'mobile' : 'web');
  }

  /**
   * Step 2 of the device-verification flow above — called from the mobile
   * app's "enter the code we emailed you" screen. On success: the new
   * device becomes the account's active device, and tokenVersion is bumped
   * so every token the OLD device is holding (access AND refresh) fails
   * JwtStrategy's/refresh()'s check on its very next use — that's the
   * actual "kick the old device to the login screen" mechanism, no session
   * store needed.
   */
  async verifyDevice(dto: VerifyDeviceDto) {
    const identifier = dto.identifier.trim();
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: { equals: identifier, mode: 'insensitive' } }, { phone: identifier }],
      },
    });
    // Same generic error either way — this endpoint shouldn't leak whether
    // an identifier has an account, same reasoning as password reset.
    if (!user) throw new UnauthorizedException('Invalid or expired code');

    const candidate = await this.prisma.otpCode.findFirst({
      where: {
        userId: user.id,
        channel: 'EMAIL',
        purpose: DEVICE_VERIFICATION_OTP_PURPOSE,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!candidate) throw new UnauthorizedException('Invalid or expired code');

    const matches = await bcrypt.compare(dto.code, candidate.codeHash);
    if (!matches) throw new UnauthorizedException('Invalid or expired code');

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.otpCode.update({ where: { id: candidate.id }, data: { consumedAt: new Date() } });
      return tx.user.update({
        where: { id: user.id },
        data: {
          activeMobileDeviceId: dto.deviceId,
          tokenVersion: { increment: 1 },
        },
      });
    });

    // Always 'mobile' — this endpoint is only ever reached from the mobile
    // app's verify-device screen.
    return this.issueTokens(updated.id, updated.role, updated.kycTier, updated.tokenVersion, 'mobile');
  }

  private async sendDeviceVerificationCode(userId: string, email: string, firstName: string) {
    const code = randomInt(100000, 999999).toString();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + DEVICE_VERIFICATION_OTP_TTL_MINUTES * 60 * 1000);

    await this.prisma.otpCode.create({
      data: {
        userId,
        channel: 'EMAIL',
        purpose: DEVICE_VERIFICATION_OTP_PURPOSE,
        codeHash,
        expiresAt,
      },
    });

    await this.email.send({
      to: email,
      subject: 'PAYDER — verify your new device',
      text:
        `Hi ${firstName},\n\nSomeone (hopefully you) is trying to log into your PAYDER account on a ` +
        `new phone while your account is still logged in elsewhere. Enter this code in the app to ` +
        `continue: ${code}\n\nThis will sign the other phone out. It expires in ` +
        `${DEVICE_VERIFICATION_OTP_TTL_MINUTES} minutes. If this wasn't you, ignore this email and ` +
        `consider changing your password.`,
      html: renderEmailHtml({
        heading: 'Verify your new device',
        bodyHtml:
          paragraphHtml(`Hi ${firstName},`) +
          paragraphHtml(
            'Someone (hopefully you) is trying to log into your PAYDER account on a new phone while ' +
              'your account is still logged in elsewhere. Enter this code in the app to continue — ' +
              '<strong>this will sign the other phone out</strong>:',
          ) +
          pinBoxHtml(code) +
          paragraphHtml(
            `This code expires in ${DEVICE_VERIFICATION_OTP_TTL_MINUTES} minutes. If this wasn't you, ` +
              'ignore this email and consider changing your password.',
          ),
      }),
    });
  }

  /**
   * Mobile's explicit "Log out" action — releases the device lock so a
   * normal (non-verification) login can happen from anywhere afterward.
   * Deliberately does NOT bump tokenVersion (that's reserved for the
   * security-relevant "kick the OTHER device out" moment in verifyDevice
   * above) — a user logging themselves out doesn't need their own
   * just-used tokens to be force-invalidated, and the client is about to
   * discard them anyway.
   */
  async logoutMobileDevice(userId: string, deviceId?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return { loggedOut: true };
    // Only clear the lock if this IS the currently-active device (a stale
    // logout call from an already-superseded device shouldn't release a
    // NEWER device's lock).
    if (!deviceId || user.activeMobileDeviceId === deviceId) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { activeMobileDeviceId: null },
      });
    }
    return { loggedOut: true };
  }

  /**
   * Exchanges a still-valid refresh token for a new access/refresh pair.
   * Re-reads the user (rather than trusting the role/kycTier baked into the
   * refresh token's payload) so a role change or KYC tier upgrade that
   * happened while the token was outstanding takes effect on the very next
   * refresh instead of waiting up to JWT_REFRESH_TTL (30d) for the old
   * token to expire naturally.
   *
   * Refresh-token-reuse detection (killing the whole session family if a
   * rotated-out token is replayed) is still a TODO — see the comment in
   * issueTokens() — this only verifies the token is a legitimately-signed,
   * unexpired refresh token for an active user.
   */
  async refresh(refreshToken: string) {
    let payload: { sub: string; tokenVersion?: number; platform?: 'web' | 'mobile' };
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.get('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Account is suspended');
    }
    // Same single-active-mobile-device kill switch JwtStrategy applies to
    // access tokens (see that file's comment, including why this is gated
    // on `platform === 'mobile'` — tokenVersion is shared with web, and the
    // device-lock feature must not touch web sessions).
    if (payload.platform === 'mobile' && (payload.tokenVersion ?? 0) !== user.tokenVersion) {
      throw new UnauthorizedException('This session has been signed out — please log in again');
    }

    // Re-issue with the SAME platform the original login used, so a
    // refreshed web token stays exempt from the mobile kill switch and a
    // refreshed mobile token stays subject to it, for as long as the
    // refresh token keeps getting renewed.
    return this.issueTokens(user.id, user.role, user.kycTier, user.tokenVersion, payload.platform ?? 'web');
  }

  async issueTokens(
    userId: string,
    role: string,
    kycTier: string,
    tokenVersion = 0,
    platform: 'web' | 'mobile' = 'web',
  ) {
    const sessionFamily = randomUUID();
    const payload = { sub: userId, role, kycTier, sessionFamily, tokenVersion, platform };

    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.get('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get('JWT_ACCESS_TTL') ?? '15m',
    });
    const refreshToken = await this.jwt.signAsync(payload, {
      secret: this.config.get('JWT_REFRESH_SECRET'),
      expiresIn: this.config.get('JWT_REFRESH_TTL') ?? '30d',
    });

    // TODO: persist { sessionFamily, userId, refreshTokenHash, revoked } so a
    // replayed/reused refresh token can be detected and the whole family
    // killed (standard token-theft mitigation — see architecture doc §8).

    return { accessToken, refreshToken };
  }

  /**
   * Forgot-password flow, step 1. Mirrors KycService.requestOtp's shape
   * exactly (OtpCode table, bcrypt-hashed 6-digit code, EmailService.send)
   * but works for a logged-out caller identified by email rather than a
   * userId — that's the whole reason this isn't just a call into KycService.
   *
   * Deliberately always returns the same { sent: true } response whether or
   * not the email belongs to a real account — a different response for
   * "no such account" would let this endpoint be used to enumerate
   * registered emails, which is exactly the kind of thing worth avoiding on
   * a fintech app's public auth surface.
   */
  async requestPasswordReset(dto: RequestPasswordResetDto) {
    // Same case-insensitive matching as login() — a customer typing their
    // email into "forgot password" shouldn't need to remember the exact
    // casing they signed up with either. findFirst (not findUnique) because
    // Prisma's `mode: 'insensitive'` filter isn't accepted on a findUnique's
    // unique-field shorthand.
    const user = await this.prisma.user.findFirst({
      where: { email: { equals: dto.email.trim(), mode: 'insensitive' } },
    });
    if (user) {
      const code = randomInt(100000, 999999).toString();
      const codeHash = await bcrypt.hash(code, 10);
      const expiresAt = new Date(Date.now() + PASSWORD_RESET_OTP_TTL_MINUTES * 60 * 1000);

      await this.prisma.otpCode.create({
        data: {
          userId: user.id,
          channel: 'EMAIL',
          purpose: PASSWORD_RESET_OTP_PURPOSE,
          codeHash,
          expiresAt,
        },
      });

      // Stubbed (see EmailService) — no real provider wired up yet, so
      // nothing reaches an actual inbox today, but the code is logged
      // server-side and this flow is fully testable end-to-end already;
      // swapping in SendGrid/Postmark later changes nothing here.
      await this.email.send({
        to: user.email,
        subject: 'Reset your PAYDER password',
        text: `Your PAYDER password reset code is ${code}. It expires in ` +
          `${PASSWORD_RESET_OTP_TTL_MINUTES} minutes. If you didn't request this, ignore this email.`,
      });
    }

    return { sent: true, expiresInMinutes: PASSWORD_RESET_OTP_TTL_MINUTES };
  }

  /**
   * Forgot-password flow, step 2. Consumes the OTP the same way
   * KycService.confirmOtp does (bcrypt.compare, then mark consumedAt so it
   * can't be replayed) and, on success, overwrites passwordHash directly —
   * there's no "old password" to check since the whole point is the user no
   * longer has one they remember.
   */
  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.prisma.user.findFirst({
      where: { email: { equals: dto.email.trim(), mode: 'insensitive' } },
    });
    // Same shape of error either way (bad code vs. no such user) so this
    // can't be used to probe which emails have accounts either.
    if (!user) throw new BadRequestException('Invalid or expired code');

    const candidate = await this.prisma.otpCode.findFirst({
      where: {
        userId: user.id,
        channel: 'EMAIL',
        purpose: PASSWORD_RESET_OTP_PURPOSE,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!candidate) throw new BadRequestException('Invalid or expired code');

    const matches = await bcrypt.compare(dto.code, candidate.codeHash);
    if (!matches) throw new BadRequestException('Invalid or expired code');

    const passwordHash = await bcrypt.hash(dto.newPassword, 12);

    await this.prisma.$transaction([
      this.prisma.otpCode.update({
        where: { id: candidate.id },
        data: { consumedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash },
      }),
    ]);

    return { reset: true };
  }
}
