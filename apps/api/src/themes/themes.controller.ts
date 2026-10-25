import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { IsObject, IsOptional } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthPayload } from '../common/decorators/current-user.decorator';
import { allowedMime, assertUploadSignature, uploadFilename } from '../common/upload';
import { ThemesService, ThemeSurfaces, ThemeChrome } from './themes.service';

const THEME_ROOT = join(process.cwd(), 'uploads', 'themes');

function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

class SaveThemeDto {
  @IsOptional()
  @IsObject()
  surfaces?: ThemeSurfaces;

  @IsOptional()
  @IsObject()
  chrome?: ThemeChrome;
}

@Controller('api/community/themes')
@UseGuards(JwtAuthGuard)
export class ThemesController {
  constructor(private readonly themes: ThemesService) {}

  @Get('me')
  me(@CurrentUser() user: AuthPayload) {
    return this.themes.get(user.id);
  }

  @Put('me')
  save(@CurrentUser() user: AuthPayload, @Body() body: SaveThemeDto) {
    return this.themes.save(user.id, {
      surfaces: body.surfaces || {},
      chrome: body.chrome || {},
    });
  }

  @Delete('me')
  reset(@CurrentUser() user: AuthPayload) {
    return this.themes.reset(user.id);
  }

  @Post('media')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          ensureDir(THEME_ROOT);
          cb(null, THEME_ROOT);
        },
        // Extensão vem do mimetype (lista fixa), nunca do nome enviado
        filename: (_req, file, cb) => cb(null, uploadFilename(file.mimetype)),
      }),
      limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => cb(null, allowedMime(file.mimetype, ['image', 'video'])),
    }),
  )
  async upload(
    @CurrentUser() user: AuthPayload,
    @UploadedFile() file: Express.Multer.File,
  ) {
    await this.themes.assertPremium(user.id);
    if (!file) throw new BadRequestException({ ok: false, error: 'file_required' });
    this.themes.assertMediaMime(file.mimetype);
    assertUploadSignature(file);
    const kind = file.mimetype.startsWith('video/')
      ? file.mimetype === 'video/webm'
        ? 'webm'
        : 'mp4'
      : file.mimetype === 'image/gif'
        ? 'gif'
        : file.mimetype === 'image/webp'
          ? 'webp'
          : 'image';
    return {
      ok: true as const,
      url: `/uploads/themes/${file.filename}`,
      media_kind: kind,
    };
  }
}
