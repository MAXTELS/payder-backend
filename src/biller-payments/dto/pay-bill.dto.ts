import { IsObject, IsOptional, IsString } from 'class-validator';

/** Shared answer payload for both the wallet (logged-in) and guest (Paystack)
 * bill-payment endpoints — see BillerPaymentsService. */
export class PayBillFieldsDto {
  // e.g. { regNo: "20/1234", department: "Computer Science", level: "200L",
  //        phone: "08012345678" } — keys/shape validated against the bill's
  // own field definitions at request time (bill-pricing.util.validateFieldValues),
  // not statically here, since fields are entirely biller-defined.
  @IsObject()
  fieldValues!: Record<string, string>;
}

export class PayBillGuestDto extends PayBillFieldsDto {
  @IsString()
  guestName!: string;

  @IsString()
  guestEmail!: string;

  @IsOptional()
  @IsString()
  guestPhone?: string;
}
