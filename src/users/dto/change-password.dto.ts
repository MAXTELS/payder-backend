import { IsString, MinLength } from 'class-validator';

export class ChangePasswordDto {
  // Required — a logged-in user changing their own password must prove they
  // know the current one (this is not the admin "set new password" path,
  // which doesn't need it — see admin/dto/set-user-password.dto.ts).
  @IsString()
  currentPassword!: string;

  @IsString()
  @MinLength(8, { message: 'newPassword must be at least 8 characters' })
  newPassword!: string;
}
