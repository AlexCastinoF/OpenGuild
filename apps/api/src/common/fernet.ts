import { createHmac, createDecipheriv, createCipheriv, randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

function loadFernetRawKey(): Buffer {
  const envKey = (process.env.ASF_FERNET_KEY || '').trim();
  if (envKey) return Buffer.from(envKey.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

  const envFile = (process.env.ASF_FERNET_KEY_FILE || '').trim();
  const candidates = [
    envFile,
    resolve(__dirname, '..', '..', '..', '..', 'archi-steam-farm-py', 'configs', '.secret.key'),
    'H:\\cs2teste\\archi-steam-farm-py\\configs\\.secret.key',
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (existsSync(p)) {
      const raw = readFileSync(p, 'utf8').trim();
      return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    }
  }
  throw new Error('ASF Fernet key missing (set ASF_FERNET_KEY_FILE)');
}

function urlsafeB64Decode(s: string): Buffer {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from((s + pad).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function urlsafeB64Encode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fernetDecrypt(token: string): string {
  const raw = (token || '').trim();
  if (!raw) return '';
  try {
    const key = loadFernetRawKey();
    const signingKey = key.subarray(0, 16);
    const encryptionKey = key.subarray(16, 32);
    const tokenBuf = urlsafeB64Decode(raw);
    if (tokenBuf.length < 57 || tokenBuf[0] !== 0x80) return '';
    const iv = tokenBuf.subarray(9, 25);
    const ciphertext = tokenBuf.subarray(25, tokenBuf.length - 32);
    const hmac = tokenBuf.subarray(tokenBuf.length - 32);
    const signed = tokenBuf.subarray(0, tokenBuf.length - 32);
    const expected = createHmac('sha256', signingKey).update(signed).digest();
    if (expected.length !== hmac.length || !timingSafeEqual(expected, hmac)) return '';
    const decipher = createDecipheriv('aes-128-cbc', encryptionKey, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export function fernetEncrypt(plain: string): string {
  const text = String(plain || '');
  if (!text) return '';
  const key = loadFernetRawKey();
  const signingKey = key.subarray(0, 16);
  const encryptionKey = key.subarray(16, 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-128-cbc', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const header = Buffer.alloc(9);
  header[0] = 0x80;
  header.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)), 1);
  const signed = Buffer.concat([header, iv, ciphertext]);
  const hmac = createHmac('sha256', signingKey).update(signed).digest();
  return urlsafeB64Encode(Buffer.concat([signed, hmac]));
}
