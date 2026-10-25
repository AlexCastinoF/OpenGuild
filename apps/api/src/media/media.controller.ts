import {
  BadRequestException,
  Controller,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthPayload } from '../common/decorators/current-user.decorator';
import { allowedMime, assertUploadSignature, extForMime } from '../common/upload';

const UPLOAD_ROOT = join(process.cwd(), 'uploads');
const STAGING = join(UPLOAD_ROOT, 'community');

function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function folderForKind(kind: string): { dir: string; urlPrefix: string; prefix: string } {
  const k = (kind || '').trim().toLowerCase();
  if (k === 'avatar' || k === 'profile') {
    return { dir: join(UPLOAD_ROOT, 'avatars'), urlPrefix: '/uploads/avatars', prefix: 'u' };
  }
  if (k === 'theme' || k === 'themes') {
    return { dir: join(UPLOAD_ROOT, 'themes'), urlPrefix: '/uploads/themes', prefix: 'theme' };
  }
  if (k === 'brand' || k === 'brand-logo' || k === 'brand-favicon' || k === 'brand-icon' || k === 'brand-ico') {
    return { dir: join(UPLOAD_ROOT, 'brand'), urlPrefix: '/uploads/brand', prefix: k.replace(/-/g, '_') };
  }
  if (k === 'banner') {
    return { dir: join(UPLOAD_ROOT, 'community'), urlPrefix: '/uploads/community', prefix: 'banner' };
  }
  if (k === 'channel') {
    return { dir: join(UPLOAD_ROOT, 'community'), urlPrefix: '/uploads/community', prefix: 'ch' };
  }
  return { dir: join(UPLOAD_ROOT, 'community'), urlPrefix: '/uploads/community', prefix: 'c' };
}

@Controller('api/community')
@UseGuards(JwtAuthGuard)
export class MediaController {
  @Post('media')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          try {
            ensureDir(STAGING);
            cb(null, STAGING);
          } catch (err) {
            cb(err as Error, STAGING);
          }
        },
        // Extensão vem do mimetype (lista fixa), nunca do nome enviado
        filename: (_req, file, cb) =>
          cb(null, `tmp_${Date.now().toString(36)}_${randomBytes(5).toString('hex')}${extForMime(file.mimetype)}`),
      }),
      limits: { fileSize: 8 * 1024 * 1024 },
      // Antes aceitava `application/octet-stream` (qualquer arquivo): XSS armazenado via /uploads.
      // Ícone (.ico) só para a marca; conferido pela assinatura como os demais.
      fileFilter: (_req, file, cb) => cb(null, allowedMime(file.mimetype, ['image', 'icon'])),
    }),
  )
  upload(
    @CurrentUser() user: AuthPayload,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: { body?: { kind?: string } },
  ) {
    if (!file) throw new BadRequestException({ ok: false, error: 'file_required' });
    const kind = String(req.body?.kind || '');
    const k = kind.trim().toLowerCase();
    const discard = (error: string) => {
      try {
        unlinkSync(file.path);
      } catch {
        /* ignore */
      }
      throw new BadRequestException({ ok: false, error });
    };
    if (k.startsWith('brand') && user?.role !== 'super_admin') discard('forbidden');
    // .ico só faz sentido como ícone do app (marca); em avatar/banner/canal não passa
    if (allowedMime(file.mimetype, ['icon']) && !k.startsWith('brand')) discard('unsupported_media');
    assertUploadSignature(file);
    const dest = folderForKind(kind);
    ensureDir(dest.dir);
    const ext = extForMime(file.mimetype);
    const idPart = user?.id ? String(user.id) : '0';
    const finalName = `${dest.prefix}${kind === 'avatar' || kind === 'profile' ? idPart : ''}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}${ext}`;
    const finalPath = join(dest.dir, finalName);
    try {
      renameSync(file.path, finalPath);
    } catch {
      throw new BadRequestException({
        ok: false,
        error: 'upload_write_failed',
      });
    }
    return { ok: true as const, url: `${dest.urlPrefix}/${finalName}` };
  }
}
