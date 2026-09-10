import { IsString, Length } from 'class-validator';

export class VerifyOtpDto {
  @IsString()
  userId!: string;

  @IsString()
  @Length(4, 6)
  code!: string;
}
