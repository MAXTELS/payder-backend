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
      select: { isActive: true },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Account is suspended');
    }
    return { id: payload.sub, role: payload.role, kycTier: payload.kycTier };
  }
}
