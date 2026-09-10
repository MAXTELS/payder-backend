import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../common/email/email.service';
import { PiiEncryptionService } from '../common/crypto/pii-encryption.service';
import { BillerWalletService } from './biller-wallet.service';
import { CreateBillerDto } from './dto/create-biller.dto';
import { GrantBillEditDto } from './dto/grant-bill-edit.dto';

function generateTempPassword(): string {
  // Same convention as AdminService.createStaff/createUser.
  return randomBytes(12).toString('base64url').slice(0, 16);
}

const BILLER_SAFE_USER_SELECT = {
  id: true,
  email: true,
  phone: true,
  firstName: true,
  lastName: true,
  billerLabel: true,
  isActive: true,
  createdAt: true,
} as const;

type BillerUserRow = {
  id: string;
  email: string;
  phone: string;
  firstName: string;
  lastName: string;
  billerLabel: string | null;
  isActive: boolean;
  createdAt: Date;
};

/**
 * Admin-only side of the biller feature: create a biller (single or joint),
 * list/inspect them, enable/disable. See biller-feature-spec.md (project
 * doc) for the full design — this is Phase 1 of that spec.
 */
@Injectable()
export class BillersAdminService {
  constructor(
    private prisma: PrismaService,
    private email: EmailService,
    private pii: PiiEncryptionService,
    private billerWallet: BillerWalletService,
  ) {}

  async createBiller(adminId: string, dto: CreateBillerDto) {
    const expectedUserCount = dto.isJoint ? 2 : 1;
    if (dto.users.length !== expectedUserCount) {
      throw new BadRequestException(
        dto.isJoint
          ? 'A joint biller needs exactly two users (A and B)'
          : 'A single biller needs exactly one user',
      );
    }

    const emails = dto.users.map((u) => u.email);
    const phones = dto.users.map((u) => u.phone);
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email: { in: emails } }, { phone: { in: phones } }] },
    });
    if (existing) {
      throw new ConflictException('An account with one of these emails or phone numbers already exists');
    }

    const usersWithSecrets = await Promise.all(
      dto.users.map(async (u) => ({
        input: u,
        tempPassword: u.password ?? generateTempPassword(),
      })),
    );

    const { biller, createdUsers } = await this.prisma.$transaction(async (tx) => {
      const biller = await tx.biller.create({
        data: {
          name: dto.name,
          type: dto.type,
          isJoint: dto.isJoint,
          createdById: adminId,
        },
      });

      const createdUsers: BillerUserRow[] = [];
      for (let i = 0; i < usersWithSecrets.length; i++) {
        const { input, tempPassword } = usersWithSecrets[i];
        const passwordHash = await bcrypt.hash(tempPassword, 12);
        const user = await tx.user.create({
          data: {
            email: input.email,
            phone: input.phone,
            firstName: input.firstName,
            lastName: input.lastName,
            passwordHash,
            role: 'BILLER',
            billerId: biller.id,
            billerLabel: dto.isJoint ? (i === 0 ? 'A' : 'B') : null,
            ninEncrypted: this.pii.encrypt(input.nin),
          },
          select: BILLER_SAFE_USER_SELECT,
        });
        createdUsers.push(user);
      }

      return { biller, createdUsers };
    });

    // Wallet + ledger account creation isn't part of the transaction above —
    // ensureWalletForBiller runs its own transaction and is idempotent, so a
    // retry (or this call itself, if invoked again later) never double-creates
    // one. Kept outside the biller/user transaction purely to keep that one
    // focused on the identity rows.
    await this.billerWallet.ensureWalletForBiller(biller.id);

    for (let i = 0; i < usersWithSecrets.length; i++) {
      const { input, tempPassword } = usersWithSecrets[i];
      await this.email.send({
        to: input.email,
        subject: `Your PAYDER biller account — ${dto.name}`,
        text:
          `Hi ${input.firstName},\n\nAn admin set up a biller account for "${dto.name}" on PAYDER` +
          `${dto.isJoint ? ` (you are signer ${i === 0 ? 'A' : 'B'} on this joint account)` : ''}.\n\n` +
          `Email: ${input.email}\nTemporary password: ${tempPassword}\n\n` +
          `Log in, change your password, and set a transaction PIN before withdrawing.`,
      });
    }

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actorRole: 'ADMIN',
        action: 'biller.created',
        targetEntity: 'Biller',
        targetId: biller.id,
        afterState: { name: dto.name, type: dto.type, isJoint: dto.isJoint },
      },
    });

    return {
      biller,
      users: createdUsers.map((u, i) => ({
        ...u,
        // Same one-time-only convention as AdminService — only returned here
        // if the admin didn't type a specific password for that user.
        tempPassword: usersWithSecrets[i].input.password ? undefined : usersWithSecrets[i].tempPassword,
      })),
    };
  }

  async listBillers() {
    const billers = await this.prisma.biller.findMany({
      include: { users: { select: BILLER_SAFE_USER_SELECT } },
      orderBy: { createdAt: 'desc' },
    });

    // Balances aren't worth a join — fetched per-row via the ledger, same
    // "derive, never store" approach as everywhere else in the wallet code.
    return Promise.all(
      billers.map(async (b) => {
        let balance: string | null = null;
        try {
          balance = (await this.billerWallet.getBalance(b.id)).balance;
        } catch {
          balance = null; // wallet not provisioned yet — shouldn't happen post-createBiller, but don't 500 the list over it
        }
        return { ...b, balance };
      }),
    );
  }

  async getBillerDetail(id: string) {
    const biller = await this.prisma.biller.findUnique({
      where: { id },
      include: { users: { select: BILLER_SAFE_USER_SELECT }, bill: true },
    });
    if (!biller) throw new NotFoundException('Biller not found');

    const balance = await this.billerWallet.getBalance(id).catch(() => null);

    return { ...biller, wallet: balance };
  }

  async setBillerActive(adminId: string, id: string, isActive: boolean) {
    const biller = await this.prisma.biller.findUnique({ where: { id } });
    if (!biller) throw new NotFoundException('Biller not found');

    const updated = await this.prisma.$transaction(async (tx) => {
      const biller = await tx.biller.update({ where: { id }, data: { isActive } });
      // A disabled biller's users shouldn't be able to log in and act on its
      // behalf either — mirrors AdminService.setStaffActive/setUserActive.
      await tx.user.updateMany({ where: { billerId: id }, data: { isActive } });
      return biller;
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actorRole: 'ADMIN',
        action: isActive ? 'biller.activated' : 'biller.deactivated',
        targetEntity: 'Biller',
        targetId: id,
        beforeState: { isActive: biller.isActive },
        afterState: { isActive },
      },
    });

    return updated;
  }

  /**
   * Grants exactly one more edit to an otherwise-locked PUBLISHED bill, in
   * response to that biller's "biller_bill_edit" support ticket (see
   * BillersService.requestBillEdit). The unlock is consumed automatically —
   * BillersService.upsertBill clears oneTimeEditUnlockedAt again the moment
   * the biller successfully saves that one permitted edit.
   */
  async grantBillEdit(adminId: string, billerId: string, dto: GrantBillEditDto) {
    const bill = await this.prisma.billDefinition.findUnique({ where: { billerId } });
    if (!bill) throw new NotFoundException('This biller has no bill to unlock');

    const updated = await this.prisma.billDefinition.update({
      where: { billerId },
      data: { oneTimeEditUnlockedAt: new Date() },
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actorRole: 'ADMIN',
        action: 'biller.bill_edit_granted',
        targetEntity: 'BillDefinition',
        targetId: bill.id,
        afterState: { note: dto.note ?? null },
      },
    });

    return updated;
  }
}
