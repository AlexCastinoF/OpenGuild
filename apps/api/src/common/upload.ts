import { BadRequestException } from '@nestjs/common';
import { closeSync, openSync, readSync, unlinkSync } from 'fs';
import { randomBytes } from 'crypto';

/**
 * Regras de upload compartilhadas por mídia da comunidade (avatar, banner, canal, marca)
 * e pelos temas.
 *
 * Nunca confie no nome nem no mimetype enviados pelo cliente: a extensão gravada vem desta
 * lista fixa e os primeiros bytes do arquivo são conferidos depois de salvar. Sem isso, um
 * `x.html` declarado como `image/png` (ou como `application/octet-stream`, que era aceito)
 * era servido como página em `/uploads/...`, no mesmo domínio do app (XSS armazenado).
 * SVG fica fora de propósito: é XML executável.
 */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  // Ícone do app/atalho (marca): conferido pela assinatura ICO
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

export type UploadKind = 'image' | 'icon' | 'video';

function kindOf(mime: string): UploadKind | null {
  const m = (mime || '').toLowerCase();
  if (!(m in MIME_EXT)) return null;
  if (m.startsWith('video/')) return 'video';
  if (m === 'image/x-icon' || m === 'image/vnd.microsoft.icon') return 'icon';
  return 'image';
}

export function allowedMime(mime: string, kinds: UploadKind[]): boolean {
  const k = kindOf(mime);
  return !!k && kinds.includes(k);
}

/** Extensão segura derivada do mimetype — ignora o nome original. */
export function extForMime(mime: string): string {
  return MIME_EXT[(mime || '').toLowerCase()] || '.bin';
}

/** Nome aleatório com extensão derivada do mimetype. */
export function uploadFilename(mime: string, prefix = ''): string {
  return `${prefix}${Date.now().toString(36)}_${randomBytes(6).toString('hex')}${extForMime(mime)}`;
}

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

/** Confere a assinatura do arquivo contra o mimetype declarado. */
function matchesSignature(buf: Buffer, mime: string): boolean {
  switch ((mime || '').toLowerCase()) {
    case 'image/png':
      return startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
    case 'image/jpg':
      return startsWith(buf, [0xff, 0xd8, 0xff]);
    case 'image/gif':
      return startsWith(buf, [0x47, 0x49, 0x46, 0x38]);
    case 'image/webp':
      return buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP';
    case 'image/x-icon':
    case 'image/vnd.microsoft.icon':
      // ICO: reserved 0, type 1 (ícone) ou 2 (cursor), pelo menos 1 imagem
      return buf.length >= 6 && buf[0] === 0 && buf[1] === 0 && (buf[2] === 1 || buf[2] === 2) && buf[3] === 0 && (buf[4] > 0 || buf[5] > 0);
    case 'video/mp4':
      return buf.length >= 8 && buf.subarray(4, 8).toString('ascii') === 'ftyp';
    case 'video/webm':
      return startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3]);
    default:
      return false;
  }
}

/**
 * Lê os primeiros bytes do arquivo salvo e apaga o arquivo se não for o formato declarado.
 * Chame logo depois do `FileInterceptor`, antes de mover/renomear.
 */
export function assertUploadSignature(file: { path: string; mimetype: string }): void {
  const head = Buffer.alloc(16);
  let read = 0;
  try {
    const fd = openSync(file.path, 'r');
    try {
      read = readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    read = 0;
  }
  if (!matchesSignature(head.subarray(0, read), file.mimetype)) {
    try {
      unlinkSync(file.path);
    } catch {
      /* ignore */
    }
    throw new BadRequestException({ ok: false, error: 'unsupported_media' });
  }
}

/** Cabeçalhos para `/uploads`: o navegador nunca deve interpretar um upload como página. */
export const UPLOAD_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
};
