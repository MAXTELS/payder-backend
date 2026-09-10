import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  ValidateNested,
} from 'class-validator';

// Not a closed set server-side (Biller.type is a plain string — see
// schema.prisma comment), but the admin "add a biller" form only offers
// these three today, so validate against them here rather than letting any
// string through from that one form. A future admin UI for adding a new
// category would just extend this list.
const BILLER_TYPES = ['SCHOOL', 'CONTRIBUTION', 'OTHER'] as const;

export class BillerUserInputDto {
  @IsEmail()
  email!: string;

  @Matches(/^\+?[0-9]{10,14}$/, { message: 'phone must be a valid MSISDN' })
  phone!: string;

  @IsString()
  @MinLength(2)
  firstName!: string;

  @IsString()
  @MinLength(2)
  lastName!: string;

  // Nigerian NIN: 11 digits — same shape as SubmitKycDto's, encrypted the
  // same way (PiiEncryptionService) but stored on User.ninEncrypted rather
  // than a KycRecord, since billers aren't customers going through KYC tiers.
  @Matches(/^\d{11}$/, { message: 'NIN must be exactly 11 digits' })
  nin!: string;

  // Optional — if omitted, a random temp password is generated and emailed,
  // same convention as AdminService.createStaff/createUser.
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;
}

export class CreateBillerDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsIn(BILLER_TYPES)
  type!: (typeof BILLER_TYPES)[number];

  @IsBoolean()
  isJoint!: boolean;

  // Exactly 1 entry for a single biller, exactly 2 for a joint one — the
  // service double-checks this against `isJoint` rather than trusting array
  // length alone to imply it.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => BillerUserInputDto)
  users!: BillerUserInputDto[];
}
