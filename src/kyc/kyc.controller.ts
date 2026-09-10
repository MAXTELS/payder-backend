import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { KycService } from './kyc.service';
import { RequestOtpDto } from './dto/request-otp.dto';
import { ConfirmOtpDto } from './dto/confirm-otp.dto';
import { SubmitKycDto } from './dto/submit-kyc.dto';

@Controller('kyc')
export class KycController {
  constructor(private kyc: KycService) {}

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.kyc.getMine(user.id);
  }

  @Post('otp/request')
  requestOtp(@CurrentUser() user: AuthenticatedUser, @Body() dto: RequestOtpDto) {
    return this.kyc.requestOtp(user.id, dto);
  }

  @Post('otp/confirm')
  confirmOtp(@CurrentUser() user: AuthenticatedUser, @Body() dto: ConfirmOtpDto) {
    return this.kyc.confirmOtp(user.id, dto);
  }

  @Post('submit')
  submit(@CurrentUser() user: AuthenticatedUser, @Body() dto: SubmitKycDto) {
    return this.kyc.submit(user.id, dto);
  }
}
