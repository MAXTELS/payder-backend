import { IsDateString, IsString, Length, Matches } from 'class-validator';

export class SubmitKycDto {
  @IsDateString()
  dateOfBirth!: string;

  @IsString()
  @Length(5, 300)
  address!: string;

  // Nigerian NIN: 11 digits.
  @Matches(/^\d{11}$/, { message: 'NIN must be exactly 11 digits' })
  nin!: string;
}
