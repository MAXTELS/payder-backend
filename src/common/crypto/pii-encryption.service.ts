import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * AES-256-GCM at-rest encryption for PII fields that must never sit in the
 * database as plaintext — NIN today (KycRecord.ninEncrypted), BVN once that
 * step exists (KycRecord.bvnEncrypted). This is application-layer encryption
 * on top of whatever the database/disk already provides, per the comment on
 * KycRecord in schema.prisma and PAYDER-ARCHITECTURE.md's PII handling
 * section.
 *
 * Key comes from PII_ENCRYPTION_KEY (64 hex chars = 32 bytes) via env — a
 * dev-only value ships in .env the same way every other secret in this repo
 * does; production must load it from the secrets manager (§8), never commit
 * a real key to git.
 *
 * Ciphertext is stored as `${ivHex}:${authTagHex}:${cipherTextHex}` — a
 * single string column is simplest to migrate/query around, and GCM's auth
 * tag makes tampering detectable on decrypt (throws rather than returning
 * garbage).
 */
@Injectable()
export class PiiEncryptionService {
  private readonly logger = new Logger(PiiEncryptionService.name);
  private readonly key: Buffer;

  constructor(private config: ConfigService) {
    const raw = this.config.get<string>('PII_ENCRYPTION_KEY');
    if (!raw || raw.length !== 64) {
      this.logger.warn(
        'PII_ENCRYPTION_KEY is missing or not 64 hex chars (32 bytes) — falling back to a ' +
          'random in-memory key. Anything encrypted this run becomes unreadable after restart. ' +
          'Set a real PII_ENCRYPTION_KEY in .env for anything beyond local dev.',
      );
      this.key = randomBytes(32);
    } else {
      this.key = Buffer.from(raw, 'hex');
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  decrypt(payload: string): string {
    const [ivHex, authTagHex, cipherHex] = payload.split(':');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(cipherHex, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  /** Last 4 characters only — safe to show an admin reviewing a KYC submission. */
  maskForDisplay(plaintext: string): string {
    if (plaintext.length <= 4) return '*'.repeat(plaintext.length);
    return '*'.repeat(plaintext.length - 4) + plaintext.slice(-4);
  }
}
