import { Body, Controller, Post } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';

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

  @Public()
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  // Email/phone OTP verification is handled by the existing /kyc/otp/*
  // routes (see kyc.controller.ts) rather than a separate auth-level
  // route — those already do exactly this (send + confirm a code, stamp
  // emailVerifiedAt/phoneVerifiedAt), used by the mobile app's OTP screen.
  //
  // TODO: POST /auth/logout — currently a no-op client-side (the client
  // just discards its stored tokens); worth adding a real endpoint once
  // refresh-token-family persistence (see AuthService.issueTokens) exists,
  // so a logout can actually revoke the family server-side rather than
  // just stop being used.
}
