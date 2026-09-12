import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

/**
 * Shared transaction-PIN verification for every customer-facing debit flow
 * (bills/airtime/data/TV, betting, exam pins, withdrawals). Generalizes the
 * PIN pattern `BillersService.verifyPin` already used for biller withdrawals
 * onto the same `User.transactionPinHash` column, now required of CUSTOMER
 * accounts too. Kept as a plain function (not a Nest-injectable service) —
 * it needs nothing but bcrypt, so any service can import and call it
 * directly without adding it to a module's providers.
 *
 * Every purchase-side DTO's `pin` field is optional at the class-validator
 * level (see e.g. PurchaseDto) so a missing PIN surfaces this function's own
 * clear "set a PIN" / "enter your PIN" message instead of a generic
 * validation error.
 */
export async function verifyTransactionPin(
  user: { transactionPinHash: string | null },
  pin: string | undefined,
): Promise<void> {
  if (!user.transactionPinHash) {
    throw new BadRequestException(
      'Set a transaction PIN in your profile before making a payment.',
    );
  }
  if (!pin) {
    throw new BadRequestException('Enter your transaction PIN to continue.');
  }
  const ok = await bcrypt.compare(pin, user.transactionPinHash);
  if (!ok) throw new UnauthorizedException('Incorrect transaction PIN');
}

export async function hashTransactionPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, 12);
}
