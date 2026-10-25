import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

function keyFromSecret(): Buffer {
  const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
  return createHash('sha256').update(`rustdesk-session:${secret}`).digest();
}

/** AES-256-GCM: iv(12) + tag(16) + ciphertext, base64url. */
export function encryptSessionPassword(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFromSecret(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

export function decryptSessionPassword(token: string): string {
  const raw = Buffer.from(String(token || ''), 'base64url');
  if (raw.length < 28) return '';
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', keyFromSecret(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function randomSessionPassword(): string {
  // Só [a-z0-9] — evita bugs de URI/CLI com base64 (`-`, `_`)
  return randomBytes(12).toString('hex').slice(0, 16);
}
