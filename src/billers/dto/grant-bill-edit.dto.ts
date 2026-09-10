import { IsOptional, IsString, Length } from 'class-validator';

/** Admin granting a biller's support-ticket request for a one-time edit to
 * an otherwise-locked PUBLISHED bill — see BillDefinition.oneTimeEditUnlockedAt. */
export class GrantBillEditDto {
  @IsOptional()
  @IsString()
  @Length(0, 500)
  note?: string;
}
