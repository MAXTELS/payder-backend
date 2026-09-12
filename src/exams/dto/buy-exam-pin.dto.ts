import { IsIn, IsNumberString, IsString, ValidateIf } from 'class-validator';

export class BuyExamPinDto {
  // NECO added 2026-09 as a backend-priced, manually-fulfilled product (no
  // aggregator sells it yet — see ExamsService's header comment). JAMB is
  // unchanged from its original scaffold.
  @IsIn(['waec', 'neco', 'jamb'])
  examType!: 'waec' | 'neco' | 'jamb';

  @IsString()
  phone!: string;

  // 'waec' and 'neco' are priced ENTIRELY server-side (real provider/config
  // price + PAYDER's fixed ₦1,000 margin, see ExamsService.EXAM_PIN_MARKUP)
  // — the customer never gets to type or influence an amount for those two,
  // which is the whole point of this field no longer being required for
  // them. 'jamb' isn't wired into that pricing flow yet, so it still needs
  // an amount from the client the way this endpoint originally worked.
  @ValidateIf((o) => o.examType === 'jamb')
  @IsNumberString()
  amount?: string;
}
