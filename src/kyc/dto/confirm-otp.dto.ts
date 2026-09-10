import { IsIn, IsString, Length } from 'class-validator';

export class ConfirmOtpDto {
  @IsIn(['EMAIL', 'PHONE'])
  channel!: 'EMAIL' | 'PHONE';

  @IsString()
  @Length(6, 6)
  code!: string;
}
