import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';

export interface JwtPayload {
  sub: string; // user id
  role: string;
  kycTier: string;
  sessionFamily: string; // used for refresh-token-reuse detection
  // 2026-09-13: the User.tokenVersion that was current when this token was
  // issued (see that column's schema comment) — the "kill switch" for the
  // single-active-mobile-device feature. Optional so a token issued before
  // this field existed doesn't fail validation with `undefined !== 0`;
  // treated as 0 when absent, matching the column's own default.
  tokenVersion?: number;
  // Which client issued this token — 'mobile' when the login/refresh
  // carried a deviceId, 'web' otherwise (default when absent, e.g. a token
  // issued before this field existed). tokenVersion is a single counter
  // shared by the whole User row, so bumping it (verifyDevice signing an
  // old PHONE out) must NOT also invalidate that same person's WEB session
  // — the device-lock feature is mobile-only by design (see
  // AuthService.login's comment). Gating the tokenVersion check on
  // `platform === 'mobile'` below is what keeps web sessions untouched.
  platform?: 'web' | 'mobile';
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_ACCESS_SECRET'),
    });
  }

  // Whatever is returned here becomes `request.user`. A DB round trip on
  // every authenticated request is the cost of making admin "restrict this
  // account" take effect immediately rather than waiting for the access
  // token to expire (up to JWT_ACCESS_TTL later) — worth it for a control
  // that exists specifically to stop a user acting right now.
  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { isActive: true, tokenVersion: true },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Account is suspended');
    }
    // Single-active-mobile-device kill switch — see User.tokenVersion's
    // schema comment. A token minted for an OLD phone carries the
    // tokenVersion that was current at its issuance; once the new phone
    // verifies and bumps the user's tokenVersion, every such old token
    // fails this check on its very next request. Scoped to `platform ===
    // 'mobile'` only — this feature is mobile-only, and tokenVersion is one
    // counter shared by the whole User row, so an unconditional check here
    // would also sign the same person's WEB session out the instant a
    // mobile device-verification bumped it.
    if (payload.platform === 'mobile' && (payload.tokenVersion ?? 0) !== user.tokenVersion) {
      throw new UnauthorizedException('This session has been signed out — please log in again');
    }
    return { id: payload.sub, role: payload.role, kycTier: payload.kycTier };
  }
}
