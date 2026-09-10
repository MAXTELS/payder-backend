import { IsOptional, IsString } from 'class-validator';

/**
 * Query params for a biller's own payment history — filterable/grouped by
 * the SAME field keys the biller defined on their bill (e.g. ?department=
 * Computer+Science&level=100L), per the spec's "biller history is filterable
 * based on the selected inputs" requirement. Free-form on purpose — the set
 * of valid keys is whatever BillDefinition.fields declares, which
 * BillersService validates against at read time.
 */
export class ListPaymentsQueryDto {
  @IsOptional()
  @IsString()
  from?: string; // ISO date

  @IsOptional()
  @IsString()
  to?: string; // ISO date

  // Arbitrary additional field-key filters are read directly off req.query
  // by the controller (class-validator's whitelist would otherwise strip
  // them) — see BillersController.listPayments.
}
