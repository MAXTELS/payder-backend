import { Body, Controller, Post } from '@nestjs/common';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { ExamsService } from './exams.service';
import { BuyExamPinDto } from './dto/buy-exam-pin.dto';

@Controller('exams')
export class ExamsController {
  constructor(private examsService: ExamsService) {}

  @Post('pins')
  buyPin(@CurrentUser() user: AuthenticatedUser, @Body() dto: BuyExamPinDto) {
    const idempotencyKey = `${user.id}:${dto.examType}:${Date.now()}`;
    return this.examsService.buyExamPin(user.id, dto, idempotencyKey);
  }
}
