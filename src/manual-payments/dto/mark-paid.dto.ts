import { IsString, Length } from 'class-validator';

export class MarkPaidDto {
  @IsString()
  @Length(1, 100)
  providerConfirmationRef!: string;
}
