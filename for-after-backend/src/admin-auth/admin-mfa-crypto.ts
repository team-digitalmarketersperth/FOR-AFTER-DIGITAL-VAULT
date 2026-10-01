import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

// AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt
// instead of yielding a different secret. Format: v1.<iv>.<tag>.<ciphertext>
// (base64url), versioned so a key rotation can re-encrypt later.
const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

export const KEY_ERROR =
  'ADMIN_TOTP_ENCRYPTION_KEY must be 32 random bytes, base64 encoded (e.g. `openssl rand -base64 32`). Admin sign-in needs it.';

/**
 * Parses ADMIN_TOTP_ENCRYPTION_KEY. A dedicated key, never derived from
 * SESSION_SECRET, OTP peppers or DATABASE_URL. The error never contains it.
 */
export const parseTotpKey = (value: string | undefined): Buffer => {
  const trimmed = value?.trim() ?? '';
  const key = /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)
    ? Buffer.from(trimmed, 'base64')
    : Buffer.alloc(0);
  // All-zero or repeated-byte keys are placeholders, not keys.
  if (key.length !== 32 || new Set(key).size < 8) throw new Error(KEY_ERROR);
  return key;
};

export const encryptSecret = (key: Buffer, plaintext: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return [VERSION, iv, cipher.getAuthTag(), data]
    .map((part) =>
      typeof part === 'string' ? part : part.toString('base64url'),
    )
    .join('.');
};

export const decryptSecret = (key: Buffer, stored: string): string => {
  const [version, iv, tag, data] = stored.split('.');
  if (version !== VERSION || !iv || !tag || !data) {
    throw new Error('Unsupported TOTP secret format');
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
};

// Recovery codes: 16 Crockford-style base32 chars = 80 bits, shown as
// XXXX-XXXX-XXXX-XXXX. High entropy, so a plain SHA-256 is enough to store.
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';

export const generateRecoveryCode = (): string =>
  [...randomBytes(16)]
    .map((b) => RECOVERY_ALPHABET[b & 31])
    .join('')
    .replace(/(.{4})(?!$)/g, '$1-');

/** Case, spaces and hyphens do not matter when a code is typed back. */
export const normalizeRecoveryCode = (code: string) =>
  code.toUpperCase().replace(/[\s-]/g, '');

export const hashRecoveryCode = (code: string) =>
  createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
