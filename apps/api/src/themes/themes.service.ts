import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { allowedMime } from '../common/upload';
import { PrismaService } from '../prisma/prisma.service';

export const THEME_SURFACES = [
  'header',
  'rail',
  'sidebar',
  'chat',
  'stage',
  'members',
] as const;

export type ThemeSurfaceKey = (typeof THEME_SURFACES)[number];

export type ThemeSurface = {
  color?: string;
  media_url?: string;
  media_kind?: 'image' | 'gif' | 'webp' | 'webm' | 'mp4' | '';
  blur?: number;
  opacity?: number;
  floating?: boolean;
};

export type ThemeChrome = {
  accent?: string;
  accent_hover?: string;
  text?: string;
  muted?: string;
  link?: string;
  panel?: string;
  panel_2?: string;
  line?: string;
  line_strong?: string;
  card?: string;
  input?: string;
  input_border?: string;
  danger?: string;
  success?: string;
  font_family?: string;
  font_size?: number;
  contrast?: 'auto' | 'light' | 'dark';
  ui_style?: 'default' | 'floating';
};

export type ThemeSurfaces = Partial<Record<ThemeSurfaceKey, ThemeSurface>>;

export type ThemePayload = {
  surfaces: ThemeSurfaces;
  chrome: ThemeChrome;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

@Injectable()
export class ThemesService {
  constructor(private readonly prisma: PrismaService) {}

  async assertPremium(userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException({ ok: false, error: 'not_found' });
    if (user.role === 'super_admin' || user.premiumThemes) return user;
    throw new ForbiddenException({ ok: false, error: 'premium_required' });
  }

  private parseStored(raw: unknown): ThemePayload {
    const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const chrome =
      obj.chrome && typeof obj.chrome === 'object'
        ? (obj.chrome as ThemeChrome)
        : {};
    const surfaces: ThemeSurfaces = {};
    for (const key of THEME_SURFACES) {
      const v = obj[key];
      if (v && typeof v === 'object') surfaces[key] = v as ThemeSurface;
    }
    // legado: surfaces flat sem chrome wrapper
    if (!Object.keys(surfaces).length && !obj.chrome) {
      for (const key of THEME_SURFACES) {
        const v = obj[key];
        if (v && typeof v === 'object') surfaces[key] = v as ThemeSurface;
      }
    }
    return { surfaces, chrome };
  }

  async get(userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException({ ok: false, error: 'not_found' });
    const theme = await this.prisma.userTheme.findUnique({ where: { userId } });
    const parsed = this.parseStored(theme?.surfaces);
    return {
      ok: true as const,
      premium_themes: !!user.premiumThemes || user.role === 'super_admin',
      surfaces: parsed.surfaces,
      chrome: parsed.chrome,
      updated_at: theme?.updatedAt || 0,
    };
  }

  async save(userId: number, input: { surfaces?: ThemeSurfaces; chrome?: ThemeChrome }) {
    await this.assertPremium(userId);
    const cleaned: ThemeSurfaces = {};
    for (const key of THEME_SURFACES) {
      const raw = input.surfaces?.[key];
      if (!raw || typeof raw !== 'object') continue;
      const color = typeof raw.color === 'string' ? raw.color.trim().slice(0, 32) : '';
      const media_url =
        typeof raw.media_url === 'string' ? raw.media_url.trim().slice(0, 512) : '';
      const media_kind = (raw.media_kind || '') as ThemeSurface['media_kind'];
      const blur =
        raw.blur != null && Number.isFinite(Number(raw.blur))
          ? clamp(Number(raw.blur), 0, 40)
          : undefined;
      const opacity =
        raw.opacity != null && Number.isFinite(Number(raw.opacity))
          ? clamp(Number(raw.opacity), 0.05, 1)
          : undefined;
      if (!color && !media_url && blur == null && opacity == null && raw.floating !== true) continue;
      cleaned[key] = {
        ...(color ? { color } : {}),
        ...(media_url ? { media_url, media_kind: media_kind || 'image' } : {}),
        ...(blur != null ? { blur } : {}),
        ...(opacity != null ? { opacity } : {}),
        ...(raw.floating === true ? { floating: true } : {}),
      };
    }
    const chromeIn = input.chrome || {};
    const chrome: ThemeChrome = {};
    for (const k of [
      'accent',
      'accent_hover',
      'text',
      'muted',
      'link',
      'panel',
      'panel_2',
      'line',
      'line_strong',
      'card',
      'input',
      'input_border',
      'danger',
      'success',
    ] as const) {
      const v = chromeIn[k];
      if (typeof v === 'string' && /^#?[0-9a-fA-F]{3,8}$/.test(v.trim())) {
        chrome[k] = v.trim().startsWith('#') ? v.trim() : `#${v.trim()}`;
      }
    }
    if (typeof chromeIn.font_family === 'string' && chromeIn.font_family.trim()) {
      chrome.font_family = chromeIn.font_family.trim().slice(0, 120);
    }
    if (chromeIn.font_size != null && Number.isFinite(Number(chromeIn.font_size))) {
      chrome.font_size = clamp(Number(chromeIn.font_size), 12, 20);
    }
    if (chromeIn.contrast === 'auto' || chromeIn.contrast === 'light' || chromeIn.contrast === 'dark') {
      chrome.contrast = chromeIn.contrast;
    }
    if (chromeIn.ui_style === 'default' || chromeIn.ui_style === 'floating') {
      chrome.ui_style = chromeIn.ui_style;
    }

    const stored = { ...cleaned, chrome };
    const now = Date.now() / 1000;
    const row = await this.prisma.userTheme.upsert({
      where: { userId },
      create: { userId, surfaces: stored, updatedAt: now },
      update: { surfaces: stored, updatedAt: now },
    });
    const parsed = this.parseStored(row.surfaces);
    return {
      ok: true as const,
      surfaces: parsed.surfaces,
      chrome: parsed.chrome,
      updated_at: row.updatedAt,
    };
  }

  async reset(userId: number) {
    await this.assertPremium(userId);
    await this.prisma.userTheme.deleteMany({ where: { userId } });
    return { ok: true as const, surfaces: {} as ThemeSurfaces, chrome: {} as ThemeChrome };
  }

  assertMediaMime(mime: string) {
    // Lista fechada (sem SVG): a mesma de common/upload.ts
    const ok = allowedMime(mime, ['image', 'video']);
    if (!ok) throw new BadRequestException({ ok: false, error: 'unsupported_media' });
  }
}
