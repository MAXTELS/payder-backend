import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../common/email/email.service';
import { SmsService } from '../common/sms/sms.service';
import { PiiEncryptionService } from '../common/crypto/pii-encryption.service';
import { RequestOtpDto } from './dto/request-otp.dto';
import { ConfirmOtpDto } from './dto/confirm-otp.dto';
import { SubmitKycDto } from './dto/submit-kyc.dto';

const OTP_TTL_MINUTES = 10;
const OTP_PURPOSE = 'KYC_VERIFICATION';

/**
 * New-customer KYC: verify email or phone (OTP), then submit date of birth,
 * address, and NIN for admin review (see AdminController.reviewKyc for the
 * other half of this flow). Deliberately its own module rather than folded
 * into UsersModule or AdminModule — same "one directory per feature area"
 * convention as manual-payments/wallet-funding.
 *
 * NIN is encrypted at rest (PiiEncryptionService) per the KycRecord schema
 * comment — never stored or logged in plaintext.
 */
@Injectable()
export class KycService {
  constructor(
    private prisma: PrismaService,
    private email: EmailService,
    private sms: SmsService,
    private pii: PiiEncryptionService,
  ) {}

  async getMine(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { emailVerifiedAt: true, phoneVerifiedAt: true, kycTier: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const latest = await this.prisma.kycRecord.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    return {
      emailVerifiedAt: user.emailVerifiedAt,
      phoneVerifiedAt: user.phoneVerifiedAt,
      kycTier: user.kycTier,
      record: latest
        ? {
            id: latest.id,
            tier: latest.tier,
            status: latest.status,
            dateOfBirth: latest.dateOfBirth,
            address: latest.address,
            ninMasked: latest.ninEncrypted ? this.pii.maskForDisplay(this.decryptSafely(latest.ninEncrypted)) : null,
            rejectionReason: latest.rejectionReason,
            createdAt: latest.createdAt,
            verifiedAt: latest.verifiedAt,
          }
        : null,
    };
  }

  private decryptSafely(value: string): string {
    try {
      return this.pii.decrypt(value);
    } catch {
      return '';
    }
  }

  async requestOtp(userId: string, dto: RequestOtpDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const code = randomInt(100000, 999999).toString();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await this.prisma.otpCode.create({
      data: {
        userId,
        channel: dto.channel,
        purpose: OTP_PURPOSE,
        codeHash,
        expiresAt,
      },
    });

    if (dto.channel === 'EMAIL') {
      await this.email.send({
        to: user.email,
        subject: 'Your PAYDER verification code',
        text: `Your PAYDER verification code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes.`,
      });
    } else {
      await this.sms.send(
        user.phone,
        `Your PAYDER verification code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes.`,
      );
    }

    // Email/SMS delivery is stubbed (see EmailService/SmsService) — nothing
    // actually reaches the user's inbox/phone yet. The code is logged
    // server-side by those stubs so this flow is testable end-to-end today;
    // swap in real providers and this response/behavior doesn't change.
    return { sent: true, channel: dto.channel, expiresInMinutes: OTP_TTL_MINUTES };
  }

  async confirmOtp(userId: string, dto: ConfirmOtpDto) {
    const candidate = await this.prisma.otpCode.findFirst({
      where: {
        userId,
        channel: dto.channel,
        purpose: OTP_PURPOSE,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!candidate) {
      throw new BadRequestException('No active code for this channel — request a new one');
    }

    const matches = await bcrypt.compare(dto.code, candidate.codeHash);
    if (!matches) throw new BadRequestException('Incorrect code');

    await this.prisma.otpCode.update({
      where: { id: candidate.id },
      data: { consumedAt: new Date() },
    });

    const field = dto.channel === 'EMAIL' ? 'emailVerifiedAt' : 'phoneVerifiedAt';
    await this.prisma.user.update({
      where: { id: userId },
      data: { [field]: new Date() },
    });

    return { verified: true, channel: dto.channel };
  }

  async submit(userId: string, dto: SubmitKycDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (!user.emailVerifiedAt && !user.phoneVerifiedAt) {
      throw new BadRequestException('Verify your email or phone before submitting KYC');
    }

    const existingPending = await this.prisma.kycRecord.findFirst({
      where: { userId, status: 'PENDING' },
    });
    if (existingPending) {
      throw new ConflictException('You already have a KYC submission pending review');
    }

    return this.prisma.kycRecord.create({
      data: {
        userId,
        tier: 'TIER_1',
        status: 'PENDING',
        dateOfBirth: new Date(dto.dateOfBirth),
        address: dto.address,
        ninEncrypted: this.pii.encrypt(dto.nin),
      },
    });
  }
}
