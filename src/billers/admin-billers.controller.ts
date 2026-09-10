import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { BillersAdminService } from './billers-admin.service';
import { CreateBillerDto } from './dto/create-biller.dto';
import { GrantBillEditDto } from './dto/grant-bill-edit.dto';

/**
 * Admin's "add a biller" flow — own controller under /admin/billers rather
 * than folded into AdminController, same one-directory-per-feature
 * convention as withdrawals/manual-payments/wallet-funding.
 */
@Roles('ADMIN')
@Controller('admin/billers')
export class AdminBillersController {
  constructor(private billersAdmin: BillersAdminService) {}

  @Get()
  list() {
    return this.billersAdmin.listBillers();
  }

  @Post()
  create(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CreateBillerDto) {
    return this.billersAdmin.createBiller(admin.id, dto);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.billersAdmin.getBillerDetail(id);
  }

  @Patch(':id/active')
  setActive(
    @Param('id') id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body('isActive') isActive: boolean,
  ) {
    return this.billersAdmin.setBillerActive(admin.id, id, isActive);
  }

  // Grants a one-time edit to an otherwise-locked PUBLISHED bill, in response
  // to a biller's "biller_bill_edit" support ticket (see
  // BillersService.requestBillEdit). Re-locks itself the moment the biller
  // saves that one permitted edit — see BillersService.upsertBill.
  @Patch(':id/grant-bill-edit')
  grantBillEdit(
    @Param('id') billerId: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: GrantBillEditDto,
  ) {
    return this.billersAdmin.grantBillEdit(admin.id, billerId, dto);
  }
}
