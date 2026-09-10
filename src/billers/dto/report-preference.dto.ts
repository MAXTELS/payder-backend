import { IsIn } from 'class-validator';

export class SetReportPreferenceDto {
  // Per biller-USER (not per biller) — see BillerReportPreference schema
  // comment: a joint biller's A and B each set this independently.
  @IsIn(['DAILY', 'WEEKLY', 'EVERY_3_DAYS', 'OFF'])
  frequency!: 'DAILY' | 'WEEKLY' | 'EVERY_3_DAYS' | 'OFF';
}
