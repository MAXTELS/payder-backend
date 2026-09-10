import { IsOptional, IsString, Length } from 'class-validator';

/**
 * Structured intake for the assisted Post-UTME registration flow (§5.5).
 * PAYDER cannot register a candidate via API — each institution runs its own
 * portal/payment channel — so this becomes a support ticket a customer-care
 * agent works manually, using these fields to know where to start.
 */
export class PostUtmeAssistDto {
  @IsString()
  @Length(2, 200)
  institutionName!: string;

  @IsString()
  @Length(4, 30)
  jambRegNumber!: string;

  @IsString()
  @Length(2, 200)
  programme!: string;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  notes?: string;
}
