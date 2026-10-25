import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from 'fs';
import { join, basename, resolve } from 'path';

type StorageRoot = {
  id: string;
  label: string;
  path: string;
};

@Injectable()
export class AdminStorageService {
  roots(): StorageRoot[] {
    const cwd = process.cwd();
    const candidates: StorageRoot[] = [
      {
        id: 'desktop-releases',
        label: 'Desktop releases (repo)',
        path: resolve(cwd, '..', '..', 'desktop-releases'),
      },
      {
        id: 'desktop-dist',
        label: 'Desktop dist',
        path: resolve(cwd, '..', 'desktop', 'dist'),
      },
      {
        id: 'uploads',
        label: 'Uploads community',
        path: resolve(cwd, 'uploads'),
      },
      {
        id: 'vps-desktop',
        label: 'VPS desktop feed',
        path: '/opt/steamfarm-react/desktop',
      },
      {
        id: 'vps-flask-desktop',
        label: 'Flask static desktop',
        path: '/opt/steamfarm/asf_py/static/desktop',
      },
    ];
    return candidates.filter((r) => existsSync(r.path));
  }

  private resolveRoot(rootId: string) {
    const root = this.roots().find((r) => r.id === rootId);
    if (!root) throw new NotFoundException({ ok: false, error: 'root_not_found' });
    return root;
  }

  private safeJoin(rootPath: string, name: string) {
    const base = basename(name);
    if (!base || base !== name.replace(/\\/g, '/').split('/').pop()) {
      throw new BadRequestException({ ok: false, error: 'invalid_name' });
    }
    const full = resolve(rootPath, base);
    if (!full.startsWith(resolve(rootPath))) {
      throw new BadRequestException({ ok: false, error: 'path_traversal' });
    }
    return full;
  }

  list(rootId?: string) {
    const roots = this.roots();
    const selected = rootId ? [this.resolveRoot(rootId)] : roots;
    const files: Array<{
      root_id: string;
      root_label: string;
      name: string;
      size: number;
      mtime: number;
      kind: string;
    }> = [];
    let totalBytes = 0;
    for (const root of selected) {
      let names: string[] = [];
      try {
        names = readdirSync(root.path);
      } catch {
        continue;
      }
      for (const name of names) {
        const full = join(root.path, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        totalBytes += st.size;
        const lower = name.toLowerCase();
        const kind = lower.endsWith('.exe')
          ? 'exe'
          : lower.endsWith('.yml') || lower.endsWith('.yaml')
            ? 'yml'
            : lower.endsWith('.blockmap')
              ? 'blockmap'
              : 'file';
        files.push({
          root_id: root.id,
          root_label: root.label,
          name,
          size: st.size,
          mtime: st.mtimeMs,
          kind,
        });
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    return {
      ok: true as const,
      roots: roots.map((r) => ({ id: r.id, label: r.label, path: r.path })),
      files,
      total_bytes: totalBytes,
    };
  }

  deleteFile(rootId: string, name: string) {
    const root = this.resolveRoot(rootId);
    const full = this.safeJoin(root.path, name);
    if (!existsSync(full)) throw new NotFoundException({ ok: false, error: 'not_found' });
    unlinkSync(full);
    return { ok: true as const };
  }

  /** Mantém latest.yml + N exes mais recentes (+ blockmaps pareados). */
  cleanupDesktop(rootId: string, keep = 1) {
    const root = this.resolveRoot(rootId);
    const listed = this.list(rootId).files.filter((f) => f.root_id === rootId);
    const exes = listed
      .filter((f) => f.kind === 'exe')
      .sort((a, b) => b.mtime - a.mtime);
    const keepNames = new Set(exes.slice(0, Math.max(1, keep)).map((f) => f.name));
    for (const exe of keepNames) {
      keepNames.add(`${exe}.blockmap`);
    }
    keepNames.add('latest.yml');
    keepNames.add('latest.yaml');
    const removed: string[] = [];
    for (const f of listed) {
      if (keepNames.has(f.name)) continue;
      if (f.kind !== 'exe' && f.kind !== 'blockmap' && f.kind !== 'yml') continue;
      try {
        unlinkSync(this.safeJoin(root.path, f.name));
        removed.push(f.name);
      } catch {
        /* ignore */
      }
    }
    // Se apagou o exe apontado pelo latest.yml, reescreve para o mais novo restante
    const ymlPath = join(root.path, 'latest.yml');
    if (existsSync(ymlPath) && exes.length) {
      const newest = exes.find((e) => keepNames.has(e.name)) || exes[0];
      try {
        const raw = readFileSync(ymlPath, 'utf8');
        if (newest && !raw.includes(newest.name)) {
          const next = raw
            .replace(/^version:.*$/m, `version: ${newest.name.match(/(\d+\.\d+\.\d+)/)?.[1] || '0.0.0'}`)
            .replace(/^path:.*$/m, `path: ${newest.name}`)
            .replace(/url: .*\.exe/g, `url: ${newest.name}`);
          writeFileSync(ymlPath, next, 'utf8');
        }
      } catch {
        /* ignore */
      }
    }
    return { ok: true as const, removed, kept: [...keepNames] };
  }
}
