import { IsEmail, IsIn, IsNumberString, IsOptional, IsString, ValidateIf } from 'class-validator';

export class BuyExamPinDto {
  // NECO added 2026-09 as a backend-priced, manually-fulfilled product (no
  // aggregator sells it yet — see ExamsService's header comment). JAMB is
  // unchanged from its original scaffold.
  @IsIn(['waec', 'neco', 'jamb'])
  examType!: 'waec' | 'neco' | 'jamb';

  // No customer-facing phone field (removed 2026-09) — it was never actually
  // used to deliver anything (VTpass only needed *a* phone-shaped value as a
  // request parameter, and the pin itself always came back in the purchase
  // response), so ExamsService now sends VTpass the buyer's own account
  // phone automatically. In its place, the form now collects (and
  // pre-fills, editable, with) an email — that's where the pin is actually
  // delivered. Optional here purely so an empty/missing value falls back to
  // the account email server-side (ExamsService.emailPin) rather than
  // failing the whole purchase over a delivery-address hiccup.
  @IsOptional()
  @IsEmail()
  email?: string;

  // 'waec' and 'neco' are priced ENTIRELY server-side (real provider/config
  // price + PAYDER's fixed ₦1,000 margin, see ExamsService.EXAM_PIN_MARKUP)
  // — the customer never gets to type or influence an amount for those two,
  // which is the whole point of this field no longer being required for
  // them. 'jamb' isn't wired into that pricing flow yet, so it still needs
  // an amount from the client the way this endpoint originally worked.
  @ValidateIf((o) => o.examType === 'jamb')
  @IsNumberString()
  amount?: string;

  // Optional here — ExamsService.buyExamPin calls verifyTransactionPin
  // (common/security/transaction-pin.util.ts), which gives its own clear
  // "set a PIN"/"enter your PIN" error rather than a generic validation one.
  @IsOptional()
  @IsString()
  pin?: string;
}
