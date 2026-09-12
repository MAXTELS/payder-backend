import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { SetTransactionPinDto } from './dto/set-transaction-pin.dto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async me(id: string) {
    const user = await this.findById(id);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash, transactionPinHash, ...safe } = user;
    // `pinSet` tells the client whether to route the profile page to "set a
    // PIN" or "change your PIN", and whether a purchase screen should even
    // bother collecting one yet — never the hash itself.
    return { ...safe, pinSet: !!transactionPinHash };
  }

  // Self-service password change for any logged-in role (customer, admin,
  // or customer care) — distinct from AdminService.setUserPassword, which
  // is an admin acting on someone else's account and skips the current-
  // password check since the admin isn't the account owner.
  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.findById(userId);

    const currentOk = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!currentOk) throw new UnauthorizedException('Current password is incorrect');

    const passwordHash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });

    return { updated: true };
  }

  /**
   * Sets or changes the customer's transaction PIN — required before every
   * debit-type purchase (bills, betting, exam pins, withdrawals; see
   * common/security/transaction-pin.util.ts). Same shape as
   * BillersService.setPin: no `currentPin` needed the very first time (the
   * account has nothing to prove it already knows), but required and
   * verified on every change after that — the customer proves they still
   * hold the current PIN, then confirms the new one twice on the client
   * before this is ever called (the client-side "enter twice" check is a
   * UX safeguard; this endpoint itself only ever receives one final value).
   */
  async setTransactionPin(userId: string, dto: SetTransactionPinDto) {
    const user = await this.findById(userId);

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

  // KYC tier upgrades intentionally live in the KYC review flow (admin-side,
  // or an automated BVN/NIN + liveness check), not here — see architecture
  // doc §3/§8. This service only reads/serves user profile data.
}
