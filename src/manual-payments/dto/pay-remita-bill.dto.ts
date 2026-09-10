import { IsString, Length } from 'class-validator';

export class PayRemitaBillDto {
  @IsString()
  @Length(4, 30)
  rrr!: string;
}
