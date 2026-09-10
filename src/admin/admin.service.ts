import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../common/email/email.service';
import { CreateStaffDto } from './dto/create-staff.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDetailsDto } from './dto/update-user-details.dto';
import { SetUserPasswordDto } from './dto/set-user-password.dto';

const SAFE_USER_SELECT = {
  id: true,
  email: true,
  phone: true,
  firstName: true,
  lastName: true,
  role: true,
  kycTier: true,
  isActive: true,
  emailVerifiedAt: true,
  phoneVerifiedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

function generateTempPassword(): string {
  // 12 random bytes -> base64url, trimmed to 16 chars — good enough entropy
  // for a one-time temp password the admin relays and the user changes.
  return randomBytes(12).toString('base64url').slice(0, 16);
}

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private email: EmailService,
  ) {}

  // ---------------------------------------------------------------------
  // Reporting
  // ---------------------------------------------------------------------

  /**
   * Net total the platform owes its customers right now — the sum of every
   * CUSTOMER wallet's ledger balance (credits minus debits), computed
   * straight from ledger_entries rather than any cached column, same
   * "derive, never store" rule the rest of the ledger follows (see
   * LedgerService's header comment). Staff (ADMIN/CUSTOMER_CARE) wallets are
   * deliberately excluded — this figure is meant to answer "how much do we
   * owe our customers", which is also the number that should reconcile
   * against actual float held with Paystack/Flutterwave/the manual-transfer
   * bank accounts.
   */
  async getTotalCustomerBalance() {
    const rows = await this.prisma.$queryRaw<{ total: string | null }[]>`
      SELECT COALESCE(
        SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount ELSE -le.amount END),
        0
      )::text AS total
      FROM ledger_entries le
      JOIN ledger_accounts la ON la.id = le."ledgerAccountId"
      JOIN wallets w ON w.id = la."walletId"
      JOIN users u ON u.id = w."userId"
      WHERE u.role = 'CUSTOMER'
    `;
    const total = new Prisma.Decimal(rows[0]?.total ?? '0');

    const [customerCount, walletCount] = await Promise.all([
      this.prisma.user.count({ where: { role: 'CUSTOMER' } }),
      this.prisma.wallet.count({ where: { user: { role: 'CUSTOMER' } } }),
    ]);

    return {
      totalBalance: total.toFixed(2),
      currency: 'NGN',
      customerCount,
      walletCount,
      asOf: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------
  // KYC review (pre-existing)
  // ---------------------------------------------------------------------

  listPendingKyc() {
    return this.prisma.kycRecord.findMany({
      where: { status: 'PENDING' },
      include: { user: { select: { id: true, email: true, phone: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async reviewKyc(kycId: string, adminId: string, decision: 'APPROVED' | 'REJECTED', reason?: string) {
    const record = await this.prisma.kycRecord.findUnique({ where: { id: kycId } });
    if (!record) throw new NotFoundException('KYC record not found');

    const updated = await this.prisma.kycRecord.update({
      where: { id: kycId },
      data: {
        status: decision,
        verifiedById: adminId,
        verifiedAt: new Date(),
        rejectionReason: decision === 'REJECTED' ? reason : null,
      },
    });

    if (decision === 'APPROVED') {
      await this.prisma.user.update({
        where: { id: record.userId },
        data: { kycTier: record.tier },
      });
    }

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actorRole: 'ADMIN',
        action: `kyc.${decision.toLowerCase()}`,
        targetEntity: 'KycRecord',
        targetId: kycId,
        afterState: { status: decision, reason },
      },
    });

    return updated;
  }

  // ---------------------------------------------------------------------
  // Transactions / providers (pre-existing)
  // ---------------------------------------------------------------------

  listTransactions(params: { status?: string; userId?: string; take?: number }) {
    return this.prisma.transaction.findMany({
      where: {
        status: params.status as any,
        userId: params.userId,
      },
      orderBy: { createdAt: 'desc' },
      take: params.take ?? 50,
    });
  }

  listProviders() {
    return this.prisma.provider.findMany({ orderBy: { priority: 'asc' } });
  }

  async setProviderActive(providerId: string, adminId: string, isActive: boolean) {
    const provider = await this.prisma.provider.update({
      where: { id: providerId },
      data: { isActive },
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actorRole: 'ADMIN',
        action: isActive ? 'provider.enable' : 'provider.disable',
        targetEntity: 'Provider',
        targetId: providerId,
      },
    });

    return provider;
  }

  // ---------------------------------------------------------------------
  // Staff management (ADMIN / CUSTOMER_CARE accounts)
  // ---------------------------------------------------------------------

  listStaff() {
    return this.prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'CUSTOMER_CARE'] } },
      select: SAFE_USER_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async createStaff(adminId: string, dto: CreateStaffDto) {
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { phone: dto.phone }] },
    });
    if (existing) {
      throw new ConflictException('An account with this email or phone already exists');
    }

    const tempPassword = dto.password ?? generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    // Staff accounts don't transact, so — unlike AuthService.register() —
    // no Wallet/LedgerAccount is created here.
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        phone: dto.phone,
        firstName: dto.firstName,
        lastName: dto.lastName,
        role: dto.role,
        passwordHash,
      },
      select: SAFE_USER_SELECT,
    });

    await this.email.send({
      to: dto.email,
      subject: 'Your PAYDER staff account',
      text:
        `Hi ${dto.firstName},\n\nAn admin created a ${dto.role} account for you on PAYDER.\n\n` +
        `Email: ${dto.email}\nTemporary password: ${tempPassword}\n\n` +
        `Log in and change your password as soon as possible.`,
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actorRole: 'ADMIN',
        action: 'staff.created',
        targetEntity: 'User',
        targetId: user.id,
        afterState: { email: dto.email, role: dto.role },
      },
    });

    // Temp password is only ever returned here, once, in-band to the admin
    // who created the account — it is not retrievable afterward (only its
    // bcrypt hash is stored) and delivery to the new hire is otherwise via
    // the stubbed EmailService above.
    return { user, tempPassword: dto.password ? undefined : tempPassword };
  }

  async setStaffActive(adminId: string, staffId: string, isActive: boolean) {
    const staff = await this.requireStaff(staffId);

    const updated = await this.prisma.user.update({
      where: { id: staffId },
      data: { isActive },
      select: SAFE_USER_SELECT,
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actorRole: 'ADMIN',
        action: isActive ? 'staff.activated' : 'staff.deactivated',
        targetEntity: 'User',
        targetId: staffId,
        beforeState: { isActive: staff.isActive },
        afterState: { isActive },
      },
    });

    return updated;
  }

  async updateStaffRole(adminId: string, staffId: string, role: 'ADMIN' | 'CUSTOMER_CARE') {
    const staff = await this.requireStaff(staffId);

    const updated = await this.prisma.user.update({
      where: { id: staffId },
      data: { role },
      select: SAFE_USER_SELECT,
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actorRole: 'ADMIN',
        action: 'staff.role_changed',
        targetEntity: 'User',
        targetId: staffId,
        beforeState: { role: staff.role },
        afterState: { role },
      },
    });

    return updated;
  }

  private async requireStaff(id: string) {
    const staff = await this.prisma.user.findUnique({ where: { id } });
    if (!staff) throw new NotFoundException('Staff account not found');
    if (staff.role !== 'ADMIN' && staff.role !== 'CUSTOMER_CARE') {
      throw new BadRequestException('That account is not a staff account');
    }
    return staff;
  }

  // ---------------------------------------------------------------------
  // Audit log — "staff logs": what action was taken, by whom, on what.
  // ---------------------------------------------------------------------

  listAuditLogs(params: { actorId?: string; targetEntity?: string; take?: number; skip?: number }) {
    return this.prisma.auditLog.findMany({
      where: {
        actorId: params.actorId,
        targetEntity: params.targetEntity,
      },
      include: {
        actor: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: params.take ?? 100,
      skip: params.skip ?? 0,
    });
  }

  // ---------------------------------------------------------------------
  // User management (any role — mainly customers)
  // ---------------------------------------------------------------------

  async listUsers(params: { role?: string; q?: string; take?: number; skip?: number }) {
    const where: any = {};
    if (params.role) where.role = params.role;
    if (params.q) {
      where.OR = [
        { email: { contains: params.q, mode: 'insensitive' } },
        { phone: { contains: params.q } },
        { firstName: { contains: params.q, mode: 'insensitive' } },
        { lastName: { contains: params.q, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: SAFE_USER_SELECT,
        orderBy: { createdAt: 'desc' },
        take: params.take ?? 50,
        skip: params.skip ?? 0,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { items, total };
  }

  async getUserDetail(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        ...SAFE_USER_SELECT,
        wallet: { include: { ledgerAccount: true } },
      },
    });
    if (!user) throw new NotFoundException('User not found');

    const [transactions, kycRecords, supportTickets, auditLogs] = await Promise.all([
      this.prisma.transaction.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.kycRecord.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' } }),
      this.prisma.supportTicket.findMany({ where: { customerId: id }, orderBy: { createdAt: 'desc' } }),
      // History of admin actions taken ON this account (not by it).
      this.prisma.auditLog.findMany({
        where: { targetEntity: 'User', targetId: id },
        include: { actor: { select: { firstName: true, lastName: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    let balance: string | null = null;
    if (user.wallet?.ledgerAccount) {
      const [credits, debits] = await Promise.all([
        this.prisma.ledgerEntry.aggregate({
          where: { ledgerAccountId: user.wallet.ledgerAccount.id, direction: 'CREDIT' },
          _sum: { amount: true },
        }),
        this.prisma.ledgerEntry.aggregate({
          where: { ledgerAccountId: user.wallet.ledgerAccount.id, direction: 'DEBIT' },
          _sum: { amount: true },
        }),
      ]);
      const creditTotal = credits._sum.amount ?? 0;
      const debitTotal = debits._sum.amount ?? 0;
      balance = (Number(creditTotal) - Number(debitTotal)).toFixed(2);
    }

    return {
      user,
      wallet: user.wallet
        ? { id: user.wallet.id, isFrozen: user.wallet.isFrozen, balance, currency: user.wallet.currency }
        : null,
      transactions,
      kycRecords,
      supportTickets,
      auditLogs,
    };
  }

  async updateUserDetails(adminId: string, id: string, dto: UpdateUserDetailsDto) {
    const before = await this.prisma.user.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('User not found');

    if (dto.email || dto.phone) {
      const clash = await this.prisma.user.findFirst({
        where: {
          id: { not: id },
          OR: [dto.email ? { email: dto.email } : undefined, dto.phone ? { phone: dto.phone } : undefined].filter(
            Boolean,
          ) as any,
        },
      });
      if (clash) throw new ConflictException('Another account already uses that email or phone');
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: dto,
      select: SAFE_USER_SELECT,
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actorRole: 'ADMIN',
        action: 'user.details_corrected',
        targetEntity: 'User',
        targetId: id,
        beforeState: {
          firstName: before.firstName,
          lastName: before.lastName,
          email: before.email,
          phone: before.phone,
        },
        afterState: { ...dto },
      },
    });

    return updated;
  }

  async setUserActive(adminId: string, id: string, isActive: boolean, reason?: string) {
    const before = await this.prisma.user.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('User not found');

    const updated = await this.prisma.user.update({
      where: { id },
      data: { isActive },
      select: SAFE_USER_SELECT,
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actorRole: 'ADMIN',
        action: isActive ? 'user.unrestricted' : 'user.restricted',
        targetEntity: 'User',
        targetId: id,
        beforeState: { isActive: before.isActive },
        afterState: { isActive, reason },
      },
    });

    return updated;
  }

  async setWalletFrozen(adminId: string, userId: string, isFrozen: boolean) {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('This user has no wallet');

    const updated = await this.prisma.wallet.update({
      where: { id: wallet.id },
      data: { isFrozen },
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actorRole: 'ADMIN',
        action: isFrozen ? 'wallet.frozen' : 'wallet.unfrozen',
        targetEntity: 'Wallet',
        targetId: wallet.id,
        beforeState: { isFrozen: wallet.isFrozen },
        afterState: { isFrozen },
      },
    });

    return updated;
  }

  async createUser(adminId: string, dto: CreateUserDto) {
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { phone: dto.phone }] },
    });
    if (existing) {
      throw new ConflictException('An account with this email or phone already exists');
    }

    const tempPassword = dto.password ?? generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: dto.email,
          phone: dto.phone,
          firstName: dto.firstName,
          lastName: dto.lastName,
          passwordHash,
        },
      });
      const wallet = await tx.wallet.create({ data: { userId: created.id } });
      await tx.ledgerAccount.create({
        data: { name: `user:${created.id}`, wallet: { connect: { id: wallet.id } } },
      });
      return created;
    });

    await this.email.send({
      to: dto.email,
      subject: 'Your PAYDER account',
      text:
        `Hi ${dto.firstName},\n\nAn account was created for you on PAYDER by an admin.\n\n` +
        `Email: ${dto.email}\nTemporary password: ${tempPassword}\n\n` +
        `Log in and change your password as soon as possible.`,
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actorRole: 'ADMIN',
        action: 'user.created_by_admin',
        targetEntity: 'User',
        targetId: user.id,
        afterState: { email: dto.email },
      },
    });

    return {
      user: { id: user.id, email: user.email, phone: user.phone },
      tempPassword: dto.password ? undefined : tempPassword,
    };
  }

  async deleteUser(adminId: string, id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    const beforeState = {
      email: user.email,
      phone: user.phone,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    };

    // Refuse to hard-delete an account that has ever acted as staff (it
    // would cascade-delete its AuditLog rows via the required actor
    // relation, destroying history). Deactivate it instead — "delete" from
    // the admin UI should always do *something* safe, not just error out.
    const actedAsStaff = await this.prisma.auditLog.findFirst({ where: { actorId: id } });
    if (actedAsStaff) {
      return this.deactivateInsteadOfDelete(
        adminId,
        id,
        user,
        beforeState,
        'This account has audit-log history as an actor (a staff action) — deleting it would destroy that log, so it was deactivated instead.',
      );
    }

    try {
      await this.prisma.user.delete({ where: { id } });
    } catch (err: any) {
      // Related records (wallet, transactions, KYC, manual-payment/
      // wallet-funding requests, OTP codes, etc.) protect this account from
      // a hard delete via a FK RESTRICT constraint. Prisma surfaces this
      // two different ways depending on the exact constraint: sometimes as
      // its own "known" P2003 error, but for some Postgres RESTRICT
      // violations (raw Postgres code 23001) it comes back as a generic
      // PrismaClientUnknownRequestError with no `.code` at all — checking
      // only `err.code === 'P2003'` misses that second case entirely and
      // was crashing this endpoint with a bare 500 instead of doing
      // anything useful. Treat both the same way.
      const isForeignKeyViolation =
        err?.code === 'P2003' ||
        (typeof err?.message === 'string' && /foreign key|restrict|violates/i.test(err.message));
      if (!isForeignKeyViolation) throw err;

      return this.deactivateInsteadOfDelete(
        adminId,
        id,
        user,
        beforeState,
        'This account has related records (wallet, transactions, KYC, etc.) and cannot be permanently deleted — it was deactivated instead to keep those records intact.',
      );
    }

    // Snapshot after a successful delete — targetId is a plain string
    // column (not an FK), so this AuditLog row survives fine even though
    // the User row it describes is now gone.
    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actorRole: 'ADMIN',
        action: 'user.deleted',
        targetEntity: 'User',
        targetId: id,
        beforeState,
      },
    });

    return { deleted: true, deactivated: false, id };
  }

  private async deactivateInsteadOfDelete(
    adminId: string,
    id: string,
    user: { isActive: boolean },
    beforeState: Record<string, unknown>,
    reason: string,
  ) {
    if (user.isActive) {
      await this.prisma.user.update({ where: { id }, data: { isActive: false } });
    }

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actorRole: 'ADMIN',
        action: 'user.delete_blocked_deactivated_instead',
        targetEntity: 'User',
        targetId: id,
        beforeState: { ...beforeState, isActive: user.isActive },
        afterState: { isActive: false, reason },
      },
    });

    return { deleted: false, deactivated: true, id, reason };
  }

  // ---------------------------------------------------------------------
  // Password management (admin sets a new password for any account)
  // ---------------------------------------------------------------------

  async setUserPassword(adminId: string, id: string, dto: SetUserPasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    const newPassword = dto.password ?? generateTempPassword();
    const passwordHash = await bcrypt.hash(newPassword, 12);

    await this.prisma.user.update({ where: { id }, data: { passwordHash } });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actorRole: 'ADMIN',
        action: 'user.password_reset_by_admin',
        targetEntity: 'User',
        targetId: id,
        // Never log the password itself, even hashed — just that it happened.
        afterState: { resetBy: adminId },
      },
    });

    // Same one-time-only convention as createUser/createStaff: only
    // returned here if the admin didn't type a specific one themselves.
    return { id, tempPassword: dto.password ? undefined : newPassword };
  }
}
