import { IsIn, IsNumberString, IsString } from 'class-validator';

export class BuyExamPinDto {
  // NECO deliberately excluded here until an aggregator offering it is
  // confirmed and wired up — see architecture doc §5.5. Do not add it to
  // this enum without also adding a provider implementation.
  @IsIn(['waec', 'jamb'])
  examType!: 'waec' | 'jamb';

  @IsNumberString()
  amount!: string;

  @IsString()
  phone!: string;
}
