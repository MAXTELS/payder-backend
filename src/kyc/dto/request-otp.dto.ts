import { IsIn } from 'class-validator';

export class RequestOtpDto {
  @IsIn(['EMAIL', 'PHONE'])
  channel!: 'EMAIL' | 'PHONE';
}
