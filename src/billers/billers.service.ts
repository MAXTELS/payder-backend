import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WithdrawalsService } from '../withdrawals/withdrawals.service';
import { BillerWalletService } from './biller-wallet.service';
import { SetBillerPinDto } from './dto/set-biller-pin.dto';
import { BillerWithdrawDto } from './dto/biller-withdraw.dto';
import { ApproveBillerWithdrawalDto } from './dto/approve-biller-withdrawal.dto';

/**
 * Biller-self side of the feature: whatever a logged-in BILLER-role user can
 * do for their own biller. Auth is just the normal login flow (a biller-role
 * User row, same table as everyone else) — nothing here issues its own
 * tokens. See biller-feature-spec.md for the joint-withdrawal design this
 * class implements.
 */
@Injectable()
export class BillersService {
  constructor(
    private prisma: PrismaService,
    private withdrawals: WithdrawalsService,
    private billerWallet: BillerWalletService,
  ) {}

  private async requireBillerUser(userId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== 'BILLER' || !user.billerId) {
      throw new ForbiddenException('Not a biller account');
    }
    return user;
  }

  private async verifyPin(user: User, pin: string) {
    if (!user.transactionPinHash) {
      throw new BadRequestException(
        'Set a transaction PIN first — POST /billers/pin — before withdrawing.',
      );
    }
    const ok = await bcrypt.compare(pin, user.transactionPinHash);
    if (!ok) throw new UnauthorizedException('Incorrect PIN');
  }

  async getMe(userId: string) {
    const user = await this.requireBillerUser(userId);
    const biller = await this.prisma.biller.findUniqueOrThrow({
      where: { id: user.billerId! },
      include: {
        users: { select: { id: true, firstName: true, lastName: true, email: true, billerLabel: true } },
      },
    });
    const coSigner = biller.users.find((u) => u.id !== userId) ?? null;

    return {
      biller: {
        id: biller.id,
        name: biller.name,
        type: biller.type,
        isJoint: biller.isJoint,
        isActive: biller.isActive,
      },
      myLabel: user.billerLabel,
      coSigner: biller.isJoint ? coSigner : null,
      pinSet: !!user.transactionPinHash,
    };
  }

  async setPin(userId: string, dto: SetBillerPinDto) {
    const user = await this.requireBillerUser(userId);

    if (user.transactionPinHash) {
      if (!dto.currentPin) {
        throw new BadRequestException('currentPin is required to change an existing PIN');
      }
      const ok = await bcrypt.compare(dto.currentPin, user.transactionPinHash);
      if (!ok) throw new UnauthorizedException('Current PIN is incorrect');
    }

    const transactionPinHash = await bcrypt.hash(dto.pin, 12);
    await this.prisma.user.update({ where: { id: userId }, data: { transactionPinHash } });
    return { updated: true };
  }

  async getBalance(userId: string) {
    const user = await this.requireBillerUser(userId);
    return this.billerWallet.getBalance(user.billerId!);
  }

  async getStatement(userId: string, opts: { limit: number; cursor?: string }) {
    const user = await this.requireBillerUser(userId);
    return this.billerWallet.getStatement(user.billerId!, opts);
  }

  /**
   * Single biller: withdraws immediately (same shape as a customer's own
   * withdrawal). Joint biller: the initiator's PIN here is their half of
   * consent — this only creates a BillerWithdrawalDraft, debits nothing, and
   * waits for the OTHER signer to approve (approveDraft below).
   */
  async initiateWithdrawal(userId: string, dto: BillerWithdrawDto) {
    const user = await this.requireBillerUser(userId);
    await this.verifyPin(user, dto.pin);

    const biller = await this.prisma.biller.findUniqueOrThrow({ where: { id: user.billerId! } });

    if (!biller.isJoint) {
      const request = await this.withdrawals.createForBiller({
        billerId: biller.id,
        initiatorUserId: userId,
        amount: dto.amount,
        bankName: dto.bankName,
        accountNumber: dto.accountNumber,
        confirmAccountNumber: dto.confirmAccountNumber,
        accountName: dto.accountName,
      });
      return { awaitingCoSignerApproval: false, withdrawalRequest: request };
    }

    if (dto.accountNumber !== dto.confirmAccountNumber) {
      throw new BadRequestException('Account number and confirmation do not match');
    }

    const draft = await this.prisma.billerWithdrawalDraft.create({
      data: {
        billerId: biller.id,
        amount: dto.amount,
        bankName: dto.bankName,
        accountNumber: dto.accountNumber,
        accountName: dto.accountName,
        initiatedByUserId: userId,
      },
    });
    return { awaitingCoSignerApproval: true, draft };
  }

  async listDrafts(userId: string) {
    const user = await this.requireBillerUser(userId);
    return this.prisma.billerWithdrawalDraft.findMany({
      where: { billerId: user.billerId!, status: 'AWAITING_APPROVAL' },
      include: {
        initiatedBy: { select: { firstName: true, lastName: true, billerLabel: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async approveDraft(userId: string, draftId: string, dto: ApproveBillerWithdrawalDto) {
    const user = await this.requireBillerUser(userId);
    const draft = await this.prisma.billerWithdrawalDraft.findUnique({ where: { id: draftId } });
    if (!draft || draft.billerId !== user.billerId) {
      throw new NotFoundException('Withdrawal draft not found');
    }
    if (draft.status !== 'AWAITING_APPROVAL') {
      throw new BadRequestException(`This draft is already ${draft.status.toLowerCase()}`);
    }
    if (draft.initiatedByUserId === userId) {
      throw new BadRequestException(
        'The other signer needs to approve this withdrawal — you already gave your consent when you initiated it.',
      );
    }
    await this.verifyPin(user, dto.pin);

    // Only NOW does money actually move — see BillerWithdrawalDraft's schema
    // comment. `initiatorUserId` here is the approver, per
    // WithdrawalRequest's "whoever caused the debit to actually happen"
    // convention.
    const withdrawalRequest = await this.withdrawals.createForBiller({
      billerId: draft.billerId,
      initiatorUserId: userId,
      amount: draft.amount.toString(),
      bankName: draft.bankName,
      accountNumber: draft.accountNumber,
      confirmAccountNumber: draft.accountNumber,
      accountName: draft.accountName,
    });

    return this.prisma.billerWithdrawalDraft.update({
      where: { id: draftId },
      data: {
        status: 'APPROVED',
        approvedByUserId: userId,
        resolvedAt: new Date(),
        resultingWithdrawalRequestId: withdrawalRequest.id,
      },
    });
  }

  async cancelDraft(userId: string, draftId: string) {
    const user = await this.requireBillerUser(userId);
    const draft = await this.prisma.billerWithdrawalDraft.findUnique({ where: { id: draftId } });
    if (!draft || draft.billerId !== user.billerId) {
      throw new NotFoundException('Withdrawal draft not found');
    }
    if (draft.status !== 'AWAITING_APPROVAL') {
      throw new BadRequestException(`This draft is already ${draft.status.toLowerCase()}`);
    }

    return this.prisma.billerWithdrawalDraft.update({
      where: { id: draftId },
      data: { status: 'CANCELLED', resolvedAt: new Date() },
    });
  }

  async listWithdrawals(userId: string) {
    const user = await this.requireBillerUser(userId);
    return this.withdrawals.listMineForBiller(user.billerId!);
  }
}
