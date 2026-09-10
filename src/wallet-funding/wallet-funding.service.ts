import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { EmailService } from '../common/email/email.service';
import {
  CreateWalletFundingDto,
  WalletFundingDestinationKey,
} from './dto/create-wallet-funding.dto';
import { RejectWalletFundingDto } from './dto/reject-wallet-funding.dto';

// Static, PAYDER-owned bank accounts shown to every customer for manual
// funding. These are plain display data, not provider/DB-backed — same
// three accounts the founder gave us. Update here if the accounts change.
export const WALLET_FUNDING_DESTINATIONS: Record<
  WalletFundingDestinationKey,
  { label: string; accountNumber: string; accountName: string }
> = {
  ACCESS_BANK: {
    label: 'Access Bank',
    accountNumber: '1444773477',
    accountName: 'Okonkwo Onyeka Jude',
  },
  OPAY: {
    label: 'Opay',
    accountNumber: '7082878478',
    accountName: 'Okonkwo Onyeka Jude',
  },
  MONIEPOINT: {
    label: 'Moniepoint',
    accountNumber: '8137392019',
    accountName: 'Okonkwo Onyeka Jude',
  },
};

/**
 * Manual bank-transfer wallet funding: customer transfers to one of the
 * static accounts above outside the app, then tells us via this flow. NO
 * ledger entry is posted on submission — the money hasn't been confirmed as
 * received, so there's nothing to hold (contrast with ManualPaymentsService,
 * which debits immediately because that flow spends money already in the
 * wallet). Only approve() ever touches the ledger, via
 * WalletService.creditWalletFromManualFunding.
 */
@Injectable()
export class WalletFundingService {
  constructor(
    private prisma: PrismaService,
    private wallet: WalletService,
    private email: EmailService,
  ) {}

  destinations() {
    return WALLET_FUNDING_DESTINATIONS;
  }

  async create(userId: string, dto: CreateWalletFundingDto) {
    const destination = WALLET_FUNDING_DESTINATIONS[dto.destinationAccount];
    return this.prisma.walletFundingRequest.create({
      data: {
        userId,
        amount: dto.amount,
        destinationAccount: `${destination.label} — ${destination.accountNumber}`,
        senderAccountName: dto.senderAccountName,
        senderBankName: dto.senderBankName,
      },
    });
  }

  listMine(userId: string) {
    return this.prisma.walletFundingRequest.findMany({
      where: { userId },
      orderBy: { submittedAt: 'desc' },
    });
  }

  // Admin queue — oldest pending first, matching the manual-payments queue.
  listQueue(status?: string) {
    return this.prisma.walletFundingRequest.findMany({
      where: status ? { status: status as any } : undefined,
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
      orderBy: { submittedAt: 'asc' },
    });
  }

  async approve(id: string, adminId: string) {
    const request = await this.prisma.walletFundingRequest.findUnique({
      where: { id },
      include: { user: true },
    });
    if (!request) throw new NotFoundException('Wallet funding request not found');
    if (request.status !== 'PENDING') {
      throw new BadRequestException(`Request is already ${request.status.toLowerCase()}`);
    }

    const idempotencyKey = `wallet-funding:${id}`;

    const updated = await this.prisma.$transaction(async (tx) => {
      const transaction = await this.wallet.creditWalletFromManualFunding(tx, {
        userId: request.userId,
        amount: request.amount.toString(),
        idempotencyKey,
      });

      return tx.walletFundingRequest.update({
        where: { id },
        data: {
          status: 'APPROVED',
          assignedAdminId: adminId,
          creditedTransactionId: transaction.id,
          resolvedAt: new Date(),
        },
      });
    });

    await this.email.send({
      to: request.user.email,
      subject: 'PAYDER — your wallet funding was approved',
      text:
        `Hi ${request.user.firstName},\n\nYour wallet funding request for NGN ${request.amount} ` +
        `has been verified and credited to your wallet.\n\nThank you for using PAYDER.`,
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actorRole: 'ADMIN',
        action: 'wallet_funding.approved',
        targetEntity: 'WalletFundingRequest',
        targetId: id,
        afterState: { status: 'APPROVED' },
      },
    });

    return updated;
  }

  async reject(id: string, adminId: string, dto: RejectWalletFundingDto) {
    const request = await this.prisma.walletFundingRequest.findUnique({
      where: { id },
      include: { user: true },
    });
    if (!request) throw new NotFoundException('Wallet funding request not found');
    if (request.status !== 'PENDING') {
      throw new BadRequestException(`Request is already ${request.status.toLowerCase()}`);
    }

    const updated = await this.prisma.walletFundingRequest.update({
      where: { id },
      data: {
        status: 'REJECTED',
        assignedAdminId: adminId,
        rejectionReason: dto.reason,
        resolvedAt: new Date(),
      },
    });

    await this.email.send({
      to: request.user.email,
      subject: 'PAYDER — your wallet funding request could not be verified',
      text:
        `Hi ${request.user.firstName},\n\nWe could not verify your wallet funding request for NGN ` +
        `${request.amount}. Reason: ${dto.reason}\n\nIf you believe this is a mistake, please contact support.`,
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actorRole: 'ADMIN',
        action: 'wallet_funding.rejected',
        targetEntity: 'WalletFundingRequest',
        targetId: id,
        afterState: { status: 'REJECTED', reason: dto.reason },
      },
    });

    return updated;
  }
}
