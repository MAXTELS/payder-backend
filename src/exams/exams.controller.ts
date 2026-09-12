import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { ExamsService } from './exams.service';
import { BuyExamPinDto } from './dto/buy-exam-pin.dto';

@Controller('exams')
export class ExamsController {
  constructor(private examsService: ExamsService) {}

  // Powers the "you'll pay ₦X" preview on the Exam pins page — called before
  // the customer commits, so they see the real backend price (+ PAYDER's
  // margin for waec/neco) with no way to edit it. buyExamPin re-derives the
  // exact same figure server-side rather than trusting this round-trip.
  @Get('pricing')
  pricing(@Query('examType') examType?: string) {
    if (examType !== 'waec' && examType !== 'neco' && examType !== 'jamb') {
      throw new BadRequestException('examType must be one of waec, neco, jamb');
    }
    return this.examsService.getPricing(examType);
  }

  @Post('pins')
  buyPin(@CurrentUser() user: AuthenticatedUser, @Body() dto: BuyExamPinDto) {
    const idempotencyKey = `${user.id}:${dto.examType}:${Date.now()}`;
    return this.examsService.buyExamPin(user.id, dto, idempotencyKey);
  }
}
