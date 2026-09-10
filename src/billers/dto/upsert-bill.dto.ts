import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

export class BillFieldDto {
  @IsString()
  @Length(1, 50)
  key!: string;

  @IsString()
  @Length(1, 100)
  label!: string;

  @IsIn(['TEXT', 'SELECT'])
  type!: 'TEXT' | 'SELECT';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  options?: string[];
}

/**
 * Full replace-style upsert — a biller has exactly one bill (schema-enforced
 * via BillDefinition.billerId @unique), so there is no "create vs update"
 * distinction from the API's point of view; BillersService decides whether
 * that's a first save or an edit of an existing (draft, or one-time-unlocked)
 * bill.
 */
export class UpsertBillDto {
  @IsString()
  @Length(2, 150)
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BillFieldDto)
  fields!: BillFieldDto[];

  @IsIn(['FLAT', 'PER_COMBINATION'])
  pricingMode!: 'FLAT' | 'PER_COMBINATION';

  @IsOptional()
  @IsNumber()
  @Min(1)
  flatAmount?: number;

  // Map of "<value1>|<value2>" (SELECT fields, in `fields` order) -> amount.
  // Validated structurally here; completeness (every combination priced) is
  // checked at publish time, not save time, so a biller can save partial
  // progress on a draft.
  @IsOptional()
  @IsObject()
  pricingTable?: Record<string, number>;
}
