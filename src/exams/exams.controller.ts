import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ExamsService } from './exams.service';
import { BuyExamPinDto } from './dto/buy-exam-pin.dto';
import { PairgateExamType } from './providers/pairgate-education.provider';

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

  // New 2026-09-13, alongside moving waec/neco onto live Pairgate
  // fulfillment — Pairgate's education purchase never returns the pin
  // synchronously (see PairgateEducationProvider's header comment), so the
  // client polls this while a purchase sits PROCESSING, same shape as
  // GET /bills/:id/status.
  @Get('pins/:id/status')
  pinStatus(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.examsService.checkStatus(user.id, id);
  }

  // Admin-only: view/set an exam type's CACHED real price (self-heals from
  // every live Pairgate purchase — see ExamsService's header comment; this
  // route exists to seed/correct it manually, e.g. right after deploying,
  // before any real purchase has happened yet). `examType` defaults to
  // 'neco' for backward compatibility with the dashboard's original
  // NECO-only route — pass ?examType=waec to manage WAEC's cached price
  // instead. Kept on ExamsController rather than AdminController/
  // AdminModule since RolesGuard checks handler-level @Roles() just as well
  // as class-level (confirmed against roles.guard.ts), and this keeps
  // "everything about exam pins" a one-directory read.
  @Roles('ADMIN')
  @Get('admin/neco-price')
  getNecoPrice(@Query('examType') examType?: PairgateExamType) {
    return this.examsService.getNecoPriceConfig(examType);
  }

  @Roles('ADMIN')
  @Patch('admin/neco-price')
  setNecoPrice(
    @Body('sellPrice') sellPrice: number,
    @Body('costPrice') costPrice?: number,
    @Query('examType') examType?: PairgateExamType,
  ) {
    return this.examsService.setNecoPrice(sellPrice, costPrice, examType);
  }
}
