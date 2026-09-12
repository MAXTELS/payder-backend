import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { AdminService } from './admin.service';
import { CreateStaffDto } from './dto/create-staff.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDetailsDto } from './dto/update-user-details.dto';
import { SetUserPasswordDto } from './dto/set-user-password.dto';

/**
 * Everything here requires ADMIN. Customer care has its own, much narrower
 * surface in SupportController — deliberately not merged with this
 * controller, so a future audit of "what can customer care touch" is a
 * one-file read (see architecture doc §10).
 */
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(private adminService: AdminService) {}

  // -----------------------------------------------------------------------
  // Reporting
  // -----------------------------------------------------------------------

  @Get('reports/total-customer-balance')
  getTotalCustomerBalance() {
    return this.adminService.getTotalCustomerBalance();
  }

  @Get('reports/net-balance')
  getNetBalance() {
    return this.adminService.getNetBalanceOverview();
  }

  @Get('reports/portal-charges')
  getPortalCharges(@Query('days') days?: string) {
    const parsed = days ? parseInt(days, 10) : NaN;
    return this.adminService.getPortalCharges(Number.isFinite(parsed) ? parsed : undefined);
  }

  @Get('kyc/pending')
  pendingKyc() {
    return this.adminService.listPendingKyc();
  }

  @Patch('kyc/:id/review')
  reviewKyc(
    @Param('id') id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body('decision') decision: 'APPROVED' | 'REJECTED',
    @Body('reason') reason?: string,
  ) {
    return this.adminService.reviewKyc(id, admin.id, decision, reason);
  }

  @Get('transactions')
  transactions(@Query('status') status?: string, @Query('userId') userId?: string) {
    return this.adminService.listTransactions({ status, userId });
  }

  // Completes a manually-fulfilled NECO exam pin once staff have bought the
  // actual pin from NECO's own portal — see AdminService.fulfillExamPin and
  // ExamsService's header comment on why NECO has no live aggregator.
  // `email`/`message` are optional overrides: `email` re-targets the
  // confirmation away from whatever the customer typed on the exam-pins form
  // (falls back to that, then the account email, if omitted); `message` is a
  // freeform note from the admin included in that same email — see
  // fulfillExamPin's own comment for why this exists.
  @Patch('exams/:transactionId/fulfill')
  fulfillExamPin(
    @Param('transactionId') transactionId: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body('pin') pin: string,
    @Body('email') email?: string,
    @Body('message') message?: string,
  ) {
    return this.adminService.fulfillExamPin(admin.id, transactionId, pin, email, message);
  }

  @Get('providers')
  providers() {
    return this.adminService.listProviders();
  }

  @Patch('providers/:id')
  setProviderActive(
    @Param('id') id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body('isActive') isActive: boolean,
  ) {
    return this.adminService.setProviderActive(id, admin.id, isActive);
  }

  // -----------------------------------------------------------------------
  // Staff management
  // -----------------------------------------------------------------------

  @Get('staff')
  listStaff() {
    return this.adminService.listStaff();
  }

  @Post('staff')
  createStaff(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateStaffDto) {
    return this.adminService.createStaff(admin.id, dto);
  }

  @Patch('staff/:id/active')
  setStaffActive(
    @Param('id') id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body('isActive') isActive: boolean,
  ) {
    return this.adminService.setStaffActive(admin.id, id, isActive);
  }

  @Patch('staff/:id/role')
  updateStaffRole(
    @Param('id') id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body('role') role: 'ADMIN' | 'CUSTOMER_CARE',
  ) {
    return this.adminService.updateStaffRole(admin.id, id, role);
  }

  // -----------------------------------------------------------------------
  // Audit log — every admin/staff action taken, filterable by who did it.
  // -----------------------------------------------------------------------

  @Get('audit-logs')
  auditLogs(
    @Query('actorId') actorId?: string,
    @Query('targetEntity') targetEntity?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.adminService.listAuditLogs({
      actorId,
      targetEntity,
      take: take ? parseInt(take, 10) : undefined,
      skip: skip ? parseInt(skip, 10) : undefined,
    });
  }

  // -----------------------------------------------------------------------
  // User management (customers, and any account by id)
  // -----------------------------------------------------------------------

  @Get('users')
  listUsers(
    @Query('role') role?: string,
    @Query('q') q?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.adminService.listUsers({
      role,
      q,
      take: take ? parseInt(take, 10) : undefined,
      skip: skip ? parseInt(skip, 10) : undefined,
    });
  }

  @Post('users')
  createUser(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateUserDto) {
    return this.adminService.createUser(admin.id, dto);
  }

  @Get('users/:id')
  getUserDetail(@Param('id') id: string) {
    return this.adminService.getUserDetail(id);
  }

  @Patch('users/:id')
  updateUserDetails(
    @Param('id') id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: UpdateUserDetailsDto,
  ) {
    return this.adminService.updateUserDetails(admin.id, id, dto);
  }

  @Patch('users/:id/restrict')
  restrictUser(
    @Param('id') id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body('reason') reason?: string,
  ) {
    return this.adminService.setUserActive(admin.id, id, false, reason);
  }

  @Patch('users/:id/unrestrict')
  unrestrictUser(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.setUserActive(admin.id, id, true);
  }

  @Patch('users/:id/wallet/freeze')
  freezeWallet(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.setWalletFrozen(admin.id, id, true);
  }

  @Patch('users/:id/wallet/unfreeze')
  unfreezeWallet(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.setWalletFrozen(admin.id, id, false);
  }

  @Delete('users/:id')
  deleteUser(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.deleteUser(admin.id, id);
  }

  @Patch('users/:id/password')
  setUserPassword(
    @Param('id') id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: SetUserPasswordDto,
  ) {
    return this.adminService.setUserPassword(admin.id, id, dto);
  }

  // Clears the customer's transaction PIN (see AdminService.resetTransactionPin
  // for why this clears rather than sets a new value) — they'll be prompted
  // to set a fresh one from their profile page before their next payment.
  @Patch('users/:id/reset-pin')
  resetTransactionPin(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.resetTransactionPin(admin.id, id);
  }
}
