import { IsOptional, IsString, MinLength } from 'class-validator';

export class SetUserPasswordDto {
  // Optional — if the admin doesn't type a specific password, the service
  // generates a random temp one and returns it once in the response, same
  // convention as CreateUserDto/CreateStaffDto.
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;
}
