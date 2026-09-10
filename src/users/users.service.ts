import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { ChangePasswordDto } from './dto/change-password.dto';

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
    return safe;
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

  // KYC tier upgrades intentionally live in the KYC review flow (admin-side,
  // or an automated BVN/NIN + liveness check), not here — see architecture
  // doc §3/§8. This service only reads/serves user profile data.
}
