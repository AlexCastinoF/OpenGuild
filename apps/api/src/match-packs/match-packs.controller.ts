import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { Public } from '../common/decorators/public.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

const VERSION_RE = /^\d+\.\d+\.\d+$/;

type PackManifest = {
  version?: string;
  publishedAt?: string;
  changelog?: string;
  defaults?: Record<string, number>;
  sha256?: string;
  size?: number;
  dll?: string;
  minDesktopVersion?: string;
};

@Controller('api/match-packs')
@Public()
@UseGuards(JwtAuthGuard)
export class MatchPacksController {
  private packDirs(): string[] {
    const env = (process.env.MATCH_PACKS_DIR || '').trim();
    return [
      env,
      join(process.cwd(), 'match-packs'),
      join(process.cwd(), '..', '..', 'match-packs'),
      '/opt/steamfarm-react/match-packs',
    ].filter(Boolean);
  }

  private firstExistingRoot(): string | null {
    for (const dir of this.packDirs()) {
      if (dir && existsSync(dir) && statSync(dir).isDirectory()) return dir;
    }
    return null;
  }

  private resolveVersionDir(version: string): string | null {
    if (!VERSION_RE.test(version)) return null;
    const root = this.firstExistingRoot();
    if (!root) return null;
    const full = join(root, version);
    if (!existsSync(full) || !statSync(full).isDirectory()) return null;
    return full;
  }

  private readManifest(dir: string): PackManifest | null {
    const manPath = join(dir, 'manifest.json');
    if (!existsSync(manPath)) return null;
    try {
      return JSON.parse(readFileSync(manPath, 'utf8')) as PackManifest;
    } catch {
      return null;
    }
  }

  private buildIndex() {
    const root = this.firstExistingRoot();
    if (!root) {
      return { latest: null as string | null, versions: [] as Array<Record<string, unknown>>, updatedAt: null };
    }
    const indexPath = join(root, 'index.json');
    if (existsSync(indexPath)) {
      try {
        return JSON.parse(readFileSync(indexPath, 'utf8'));
      } catch {
        /* rebuild below */
      }
    }
    const versions: Array<{
      version: string;
      publishedAt: string | null;
      changelogSummary: string;
      sha256: string | null;
      size: number | null;
    }> = [];
    for (const name of readdirSync(root)) {
      if (!VERSION_RE.test(name)) continue;
      const dir = join(root, name);
      if (!statSync(dir).isDirectory()) continue;
      const man = this.readManifest(dir);
      if (!man) continue;
      const changelog = String(man.changelog || '');
      const summaryLine =
        changelog
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l.startsWith('✅') || l.startsWith('- ')) || '';
      const changelogSummary = summaryLine
        ? summaryLine.replace(/^(✅|-)\s*/, '').trim()
        : changelog.split(/\r?\n/).filter(Boolean)[0] || `Pack ${name}`;
      versions.push({
        version: man.version || name,
        publishedAt: man.publishedAt || null,
        changelogSummary,
        sha256: man.sha256 || null,
        size: man.size ?? null,
      });
    }
    versions.sort((a, b) =>
      String(b.version).localeCompare(String(a.version), undefined, { numeric: true }),
    );
    return {
      latest: versions[0]?.version || null,
      versions,
      updatedAt: new Date().toISOString(),
    };
  }

  @Get()
  list() {
    return this.buildIndex();
  }

  @Get(':version')
  manifest(@Param('version') version: string) {
    const dir = this.resolveVersionDir(version);
    if (!dir) throw new NotFoundException({ ok: false, error: 'pack_not_found' });
    const man = this.readManifest(dir);
    if (!man) throw new NotFoundException({ ok: false, error: 'manifest_missing' });
    return man;
  }

  @Get(':version/:file')
  file(
    @Param('version') version: string,
    @Param('file') file: string,
    @Res() res: Response,
  ) {
    const dir = this.resolveVersionDir(version);
    if (!dir) throw new NotFoundException({ ok: false, error: 'pack_not_found' });
    const base = String(file || '')
      .replace(/\\/g, '/')
      .split('/')
      .pop() || '';
    const SAFE_DLL = /^(SfAssignTeams|SfKillSounds)\.dll$/i;
    const SAFE_JSON = /^(sounds-catalog|manifest)\.json$/i;
    if (!SAFE_DLL.test(base) && !SAFE_JSON.test(base)) {
      throw new NotFoundException({ ok: false, error: 'invalid_file' });
    }
    const full = join(dir, base);
    if (!existsSync(full) || !statSync(full).isFile()) {
      throw new NotFoundException({ ok: false, error: 'file_missing' });
    }
    if (SAFE_JSON.test(base)) {
      res.type('application/json; charset=utf-8');
    } else {
      res.type('application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${base}"`);
    }
    return res.sendFile(full);
  }
}
