import { Body, Controller, Get, Param, Post, Put, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { BillersService } from './billers.service';
import { SetBillerPinDto } from './dto/set-biller-pin.dto';
import { BillerWithdrawDto } from './dto/biller-withdraw.dto';
import { ApproveBillerWithdrawalDto } from './dto/approve-biller-withdrawal.dto';
import { UpsertBillDto } from './dto/upsert-bill.dto';
import { BillerDepositDto } from './dto/biller-deposit.dto';
import { SetReportPreferenceDto } from './dto/report-preference.dto';
import { RequestBillEditDto } from './dto/request-bill-edit.dto';

/**
 * Everything a logged-in BILLER-role user can do for their own biller:
 * wallet balance/history, the dual-approval withdrawal flow, the bill
 * builder, wallet deposit, report-frequency preference, and payment history/
 * export. See biller-feature-spec.md project doc for the full design.
 */
@Roles('BILLER')
@Controller('billers')
export class BillersController {
  constructor(private billers: BillersService) {}

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.billers.getMe(user.id);
  }

  @Post('pin')
  setPin(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetBillerPinDto) {
    return this.billers.setPin(user.id, dto);
  }

  @Get('wallet/balance')
  balance(@CurrentUser() user: AuthenticatedUser) {
    return this.billers.getBalance(user.id);
  }

  @Get('wallet/statement')
  statement(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const parsedLimit = limit ? Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100) : 20;
    return this.billers.getStatement(user.id, { limit: parsedLimit, cursor });
  }

  @Post('wallet/withdraw')
  withdraw(@CurrentUser() user: AuthenticatedUser, @Body() dto: BillerWithdrawDto) {
    return this.billers.initiateWithdrawal(user.id, dto);
  }

  @Get('wallet/withdraw/drafts')
  drafts(@CurrentUser() user: AuthenticatedUser) {
    return this.billers.listDrafts(user.id);
  }

  @Post('wallet/withdraw/drafts/:id/approve')
  approveDraft(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ApproveBillerWithdrawalDto,
  ) {
    return this.billers.approveDraft(user.id, id, dto);
  }

  @Post('wallet/withdraw/drafts/:id/cancel')
  cancelDraft(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.billers.cancelDraft(user.id, id);
  }

  @Get('wallet/withdrawals/mine')
  withdrawals(@CurrentUser() user: AuthenticatedUser) {
    return this.billers.listWithdrawals(user.id);
  }

  @Post('wallet/deposit/initiate')
  initiateDeposit(@CurrentUser() user: AuthenticatedUser, @Body() dto: BillerDepositDto) {
    return this.billers.initiateDeposit(user.id, dto);
  }

  @Get('wallet/deposit/verify/:reference')
  verifyDeposit(@CurrentUser() user: AuthenticatedUser, @Param('reference') reference: string) {
    return this.billers.verifyDeposit(user.id, reference);
  }

  // --- Bill builder --------------------------------------------------------

  @Get('bill')
  getBill(@CurrentUser() user: AuthenticatedUser) {
    return this.billers.getBill(user.id);
  }

  @Put('bill')
  upsertBill(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpsertBillDto) {
    return this.billers.upsertBill(user.id, dto);
  }

  @Post('bill/publish')
  publishBill(@CurrentUser() user: AuthenticatedUser) {
    return this.billers.publishBill(user.id);
  }

  @Post('bill/request-edit')
  requestBillEdit(@CurrentUser() user: AuthenticatedUser, @Body() dto: RequestBillEditDto) {
    return this.billers.requestBillEdit(user.id, dto);
  }

  // --- Report preference -----------------------------------------------

  @Get('report-preference')
  getReportPreference(@CurrentUser() user: AuthenticatedUser) {
    return this.billers.getReportPreference(user.id);
  }

  @Post('report-preference')
  setReportPreference(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetReportPreferenceDto) {
    return this.billers.setReportPreference(user.id, dto);
  }

  // --- Payment history ---------------------------------------------------

  @Get('payments')
  listPayments(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query() query?: Record<string, string>,
  ) {
    const { from: _f, to: _t, ...extraFilters } = query ?? {};
    return this.billers.listPayments(user.id, { from, to, extraFilters });
  }

  @Get('payments/export.csv')
  async exportPayments(
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query() query?: Record<string, string>,
  ) {
    const { from: _f, to: _t, ...extraFilters } = query ?? {};
    const csv = await this.billers.exportPaymentsCsv(user.id, { from, to, extraFilters });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="payments.csv"');
    res.send(csv);
  }

  @Get('payments/daily-report')
  async dailyReport(
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
    @Query('date') date?: string,
  ) {
    const { csv, date: reportDate } = await this.billers.dailyReportCsv(user.id, date);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="payments-${reportDate}.csv"`);
    res.send(csv);
  }
}
