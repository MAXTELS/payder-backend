import { IsOptional, IsString } from 'class-validator';

export class LoginDto {
  @IsString()
  identifier!: string; // email or phone

  @IsString()
  password!: string;

  // 2026-09-13: mobile-only single-active-device lock (see AuthService.login
  // and User.activeMobileDeviceId's schema comment). A persistent per-install
  // UUID the mobile app generates once and stores in secure storage — sent
  // on every login attempt. Web never sends this, so web logins are never
  // subject to the device-lock check at all.
  @IsOptional()
  @IsString()
  deviceId?: string;
}
