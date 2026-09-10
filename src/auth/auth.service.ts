import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

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
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { phone: dto.phone }] },
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
            email: dto.email,
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
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.identifier }, { phone: dto.identifier }] },
    });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const passwordOk = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordOk) throw new UnauthorizedException('Invalid credentials');

    if (!user.isActive) throw new UnauthorizedException('Account is suspended');

    return this.issueTokens(user.id, user.role, user.kycTier);
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
    let payload: { sub: string };
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

    return this.issueTokens(user.id, user.role, user.kycTier);
  }

  async issueTokens(userId: string, role: string, kycTier: string) {
    const sessionFamily = randomUUID();
    const payload = { sub: userId, role, kycTier, sessionFamily };

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
}
