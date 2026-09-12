import { IsOptional, IsString, Matches } from 'class-validator';

const PIN_PATTERN = /^\d{4}$/;

/**
 * Same shape as billers' SetBillerPinDto, generalized to the customer-facing
 * PIN (`POST /users/me/pin`). `currentPin` is only required when the
 * account already has a PIN set — UsersService.setTransactionPin enforces
 * that conditionally, same as SetBillerPinDto/BillersService.setPin.
 */
export class SetTransactionPinDto {
  @Matches(PIN_PATTERN, { message: 'PIN must be exactly 4 digits' })
  pin!: string;

  @IsOptional()
  @IsString()
  currentPin?: string;
}
