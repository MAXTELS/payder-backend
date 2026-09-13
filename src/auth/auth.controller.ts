import { Body, Controller, Post } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyDeviceDto } from './dto/verify-device.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  // Mobile-only step 2, only reached when login() above responded
  // { requiresDeviceVerification: true } — see AuthService.verifyDevice.
  @Public()
  @Post('verify-device')
  verifyDevice(@Body() dto: VerifyDeviceDto) {
    return this.authService.verifyDevice(dto);
  }

  @Public()
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  // Mobile's explicit "Log out" — releases this account's device lock (see
  // AuthService.logoutMobileDevice) so a future login from anywhere doesn't
  // require email verification. Authenticated (not @Public()) since it
  // needs to know who's logging out; `deviceId` in the body lets it avoid
  // releasing a lock a NEWER device has since taken over.
  @Post('logout')
  logout(@CurrentUser() user: AuthenticatedUser, @Body('deviceId') deviceId?: string) {
    return this.authService.logoutMobileDevice(user.id, deviceId);
  }

  // Forgot-password, step 1 — logged out, so this has to be identified by
  // email rather than the JwtAuthGuard's current-user, hence @Public().
  // Always responds { sent: true } whether or not the email is registered —
  // see AuthService.requestPasswordReset's comment on why.
  @Public()
  @Post('password-reset/request')
  requestPasswordReset(@Body() dto: RequestPasswordResetDto) {
    return this.authService.requestPasswordReset(dto);
  }

  // Forgot-password, step 2 — the OTP code from step 1 plus a new password.
  @Public()
  @Post('password-reset/confirm')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  // Email/phone OTP verification is handled by the existing /kyc/otp/*
  // routes (see kyc.controller.ts) rather than a separate auth-level
  // route — those already do exactly this (send + confirm a code, stamp
  // emailVerifiedAt/phoneVerifiedAt), used by the mobile app's OTP screen.
}
