import { IsEmail, IsIn, IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class CreateStaffDto {
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

  @IsIn(['ADMIN', 'CUSTOMER_CARE'])
  role!: 'ADMIN' | 'CUSTOMER_CARE';

  // Optional — if omitted, the service generates a random temp password and
  // returns it once in the response for the admin to relay to the new hire.
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;
}
