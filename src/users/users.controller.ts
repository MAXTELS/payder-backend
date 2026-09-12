import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { UsersService } from './users.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { SetTransactionPinDto } from './dto/set-transaction-pin.dto';

@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.me(user.id);
  }

  @Patch('me/password')
  changePassword(@CurrentUser() user: AuthenticatedUser, @Body() dto: ChangePasswordDto) {
    return this.usersService.changePassword(user.id, dto);
  }

  // Set (first time) or change (currentPin required) the transaction PIN
  // required before every debit-type purchase — see
  // common/security/transaction-pin.util.ts and the profile page on web/
  // mobile that calls this.
  @Post('me/pin')
  setTransactionPin(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetTransactionPinDto) {
    return this.usersService.setTransactionPin(user.id, dto);
  }
}
