import { IsOptional, IsString, Matches } from 'class-validator';

const PIN_PATTERN = /^\d{4,6}$/;

export class SetBillerPinDto {
  @Matches(PIN_PATTERN, { message: 'pin must be 4-6 digits' })
  pin!: string;

  // Required to CHANGE an existing PIN; omitted the first time a biller-user
  // sets one (see BillersService.setPin — mirrors UsersService.changePassword's
  // current-value check, but a missing PIN is a valid starting state here,
  // unlike a password which always exists).
  @IsOptional()
  @Matches(PIN_PATTERN, { message: 'currentPin must be 4-6 digits' })
  currentPin?: string;
}
