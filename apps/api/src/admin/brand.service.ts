import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type BrandPublic = {
  ok: true;
  name: string;
  short_name: string;
  logo_url: string;
  favicon_url: string;
  app_icon_url: string;
  app_ico_url: string;
  revision: number;
  updated_at: number;
};

const DEFAULTS = {
  name: 'SteamFarm Comunidade',
  short_name: 'SteamFarm',
  logo_url: '/logo.png',
  favicon_url: '/logo.png',
  app_icon_url: '',
  app_ico_url: '',
};

@Injectable()
export class BrandService {
  constructor(private readonly prisma: PrismaService) {}

  private async row() {
    const now = Date.now() / 1000;
    return this.prisma.siteSettings.upsert({
      where: { id: 1 },
      create: { id: 1, updatedAt: now },
      update: {},
    });
  }

  async publicBrand(): Promise<BrandPublic> {
    const s = await this.row();
    const logo = (s.brandLogoUrl || '').trim() || DEFAULTS.logo_url;
    const favicon = (s.brandFaviconUrl || '').trim() || logo || DEFAULTS.favicon_url;
    return {
      ok: true,
      name: (s.brandName || '').trim() || DEFAULTS.name,
      short_name: (s.brandShortName || '').trim() || DEFAULTS.short_name,
      logo_url: logo,
      favicon_url: favicon,
      app_icon_url: (s.brandAppIconUrl || '').trim(),
      app_ico_url: (s.brandAppIcoUrl || '').trim(),
      revision: s.brandRevision || 1,
      updated_at: s.updatedAt || 0,
    };
  }

  async save(input: {
    name?: string;
    short_name?: string;
    logo_url?: string;
    favicon_url?: string;
    app_icon_url?: string;
    app_ico_url?: string;
  }): Promise<BrandPublic> {
    const now = Date.now() / 1000;
    const cur = await this.row();
    const data: Record<string, string | number> = {
      updatedAt: now,
      brandRevision: (cur.brandRevision || 1) + 1,
    };
    if (input.name !== undefined) data.brandName = String(input.name).trim().slice(0, 80) || DEFAULTS.name;
    if (input.short_name !== undefined) {
      data.brandShortName = String(input.short_name).trim().slice(0, 40) || DEFAULTS.short_name;
    }
    if (input.logo_url !== undefined) data.brandLogoUrl = String(input.logo_url).trim().slice(0, 500);
    if (input.favicon_url !== undefined) data.brandFaviconUrl = String(input.favicon_url).trim().slice(0, 500);
    if (input.app_icon_url !== undefined) data.brandAppIconUrl = String(input.app_icon_url).trim().slice(0, 500);
    if (input.app_ico_url !== undefined) data.brandAppIcoUrl = String(input.app_ico_url).trim().slice(0, 500);

    await this.prisma.siteSettings.update({ where: { id: 1 }, data });
    return this.publicBrand();
  }
}
