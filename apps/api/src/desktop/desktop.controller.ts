import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, extname } from 'path';

const ALLOWED_EXT = new Set(['.exe', '.yml', '.yaml', '.blockmap']);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,180}$/;

@Controller('desktop')
export class DesktopController {
  private desktopDirs(): string[] {
    const env = (process.env.DESKTOP_RELEASES_DIR || '').trim();
    return [
      env,
      join(process.cwd(), 'desktop'),
      join(process.cwd(), '..', '..', 'desktop-releases'),
      join(process.cwd(), '..', '..', 'desktop'),
      '/opt/steamfarm-react/desktop',
      '/opt/steamfarm-react/desktop-releases',
    ].filter(Boolean);
  }

  private firstExistingDir(): string | null {
    for (const dir of this.desktopDirs()) {
      if (dir && existsSync(dir)) return dir;
    }
    return null;
  }

  private safeName(name: string): string | null {
    const base = (name || '').trim().replace(/\\/g, '/').split('/').pop() || '';
    if (!base || base.includes('..') || !SAFE_NAME.test(base)) return null;
    const ext = extname(base).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return null;
    return base;
  }

  private resolveFile(name: string): string | null {
    const safe = this.safeName(name);
    if (!safe) return null;
    for (const dir of this.desktopDirs()) {
      if (!dir || !existsSync(dir)) continue;
      const full = join(dir, safe);
      if (existsSync(full) && statSync(full).isFile()) return full;
    }
    return null;
  }

  private parseLatestYml(text: string): { version: string; path: string } {
    const out = { version: '', path: '' };
    for (const line of (text || '').split(/\r?\n/)) {
      if (!line.includes(':')) continue;
      const i = line.indexOf(':');
      const key = line.slice(0, i).trim();
      const val = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key === 'version') out.version = val;
      if (key === 'path') out.path = val;
    }
    return out;
  }

  private findLatestExe(): { dir: string; name: string } | null {
    for (const dir of this.desktopDirs()) {
      if (!dir || !existsSync(dir)) continue;
      const ymlPath = join(dir, 'latest.yml');
      if (existsSync(ymlPath)) {
        try {
          const meta = this.parseLatestYml(readFileSync(ymlPath, 'utf8'));
          if (meta.path && existsSync(join(dir, meta.path))) {
            return { dir, name: meta.path };
          }
        } catch {
          /* fall through */
        }
      }
      const files = readdirSync(dir).filter((f) => /\.exe$/i.test(f) && !f.endsWith('.blockmap'));
      if (!files.length) continue;
      files.sort((a, b) => a.localeCompare(b));
      return { dir, name: files[files.length - 1] };
    }
    return null;
  }

  @Get('download')
  download(@Res() res: Response) {
    const hit = this.findLatestExe();
    if (!hit) {
      throw new NotFoundException({
        ok: false,
        error: 'Instalador do app desktop ainda não está publicado.',
      });
    }
    return res.download(join(hit.dir, hit.name), hit.name);
  }

  /** electron-updater generic provider: /desktop/latest.yml + exe + blockmap */
  @Get(':name')
  serve(@Param('name') name: string, @Res() res: Response) {
    if (name === 'download') {
      return this.download(res);
    }
    const full = this.resolveFile(name);
    if (!full) {
      throw new NotFoundException({ ok: false, error: 'not_found' });
    }
    const ext = extname(full).toLowerCase();
    if (ext === '.yml' || ext === '.yaml') {
      res.type('text/yaml; charset=utf-8');
    } else if (ext === '.blockmap') {
      res.type('application/octet-stream');
    } else {
      res.type('application/octet-stream');
    }
    return res.sendFile(full);
  }
}
