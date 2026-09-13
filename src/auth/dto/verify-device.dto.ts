import { IsString } from 'class-validator';

// See AuthService.login/verifyDevice — completes a mobile login that was
// held pending email verification because a DIFFERENT deviceId was already
// the account's active mobile device.
export class VerifyDeviceDto {
  @IsString()
  identifier!: string; // same email/phone the login attempt used

  @IsString()
  deviceId!: string; // the NEW device's id — must match what login() was called with

  @IsString()
  code!: string; // the 6-digit code emailed to the account
}
