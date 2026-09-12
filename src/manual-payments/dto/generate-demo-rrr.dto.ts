import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class GenerateDemoRrrDto {
  @IsNumber()
  @Min(100)
  amount!: number;

  @IsOptional()
  @IsString()
  payerName?: string;

  @IsOptional()
  @IsString()
  description?: string;
}
