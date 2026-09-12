import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { EmailModule } from '../common/email/email.module';

@Module({
  // EmailModule: password reset (§ new "forgot password" flow) sends its
  // OTP the same way KycService does — see AuthService.requestPasswordReset.
  imports: [PassportModule, JwtModule.register({}), EmailModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    // Global guards: every route requires a valid JWT unless marked @Public(),
    // and every route additionally enforces @Roles() when present. Order
    // matters — auth runs before role checks.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
