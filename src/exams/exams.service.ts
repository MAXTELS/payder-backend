import { Injectable } from '@nestjs/common';
import { WalletService } from '../wallet/wallet.service';
import { VtpassProvider } from '../bills/providers/vtpass.provider';
import { BuyExamPinDto } from './dto/buy-exam-pin.dto';

const EXAM_TYPE_TO_SERVICE_ID = {
  waec: 'waec-registration',
  jamb: 'jamb',
} as const;

/**
 * Exam e-pin sales (WAEC result-checker, JAMB e-PIN). This is deliberately
 * scoped down from "register for JAMB/Post-UTME" to "sell the e-pin the
 * candidate needs" — actual UTME/DE registration requires the candidate to
 * appear in person at a JAMB-accredited CBT centre and cannot be done via
 * API. See architecture doc §5.5 for the full explanation and what a Phase 2
 * "assisted registration" flow would look like.
 */
@Injectable()
export class ExamsService {
  constructor(
    private wallet: WalletService,
    private vtpass: VtpassProvider,
  ) {}

  async buyExamPin(userId: string, dto: BuyExamPinDto, idempotencyKey: string) {
    const transaction = await this.wallet.debitWalletForPurchase({
      userId,
      amount: dto.amount,
      type: 'EXAM_PIN',
      idempotencyKey,
    });

    if (transaction.status !== 'PENDING') return transaction;

    const result = await this.vtpass.purchase({
      requestId: transaction.id,
      serviceId: EXAM_TYPE_TO_SERVICE_ID[dto.examType],
      customerId: dto.phone,
      amount: dto.amount,
      phone: dto.phone,
    });

    return { transactionId: transaction.id, pin: result.pin, status: result.status };
  }
}
