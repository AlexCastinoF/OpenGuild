import { create } from 'zustand';

export type BrandInfo = {
  name: string;
  short_name: string;
  logo_url: string;
  favicon_url: string;
  app_icon_url: string;
  app_ico_url: string;
  revision: number;
};

const FALLBACK: BrandInfo = {
  name: 'SteamFarm Comunidade',
  short_name: 'SteamFarm',
  logo_url: '/logo.png',
  favicon_url: '/logo.png',
  app_icon_url: '',
  app_ico_url: '',
  revision: 0,
};

type BrandState = BrandInfo & {
  loaded: boolean;
  applyDocument: () => void;
  load: () => Promise<void>;
};

function applyFavicon(href: string) {
  let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  const bust = href.includes('?') ? '&' : '?';
  link.href = `${href}${bust}v=${Date.now()}`;
}

export const useBrandStore = create<BrandState>((set, get) => ({
  ...FALLBACK,
  loaded: false,
  applyDocument() {
    const b = get();
    document.title = b.name;
    applyFavicon(b.favicon_url || b.logo_url || '/logo.png');
  },
  async load() {
    try {
      const res = await fetch('/api/community/brand', { credentials: 'include' });
      if (!res.ok) throw new Error('brand_http');
      const d = (await res.json()) as Partial<BrandInfo> & { ok?: boolean };
      set({
        name: (d.name || '').trim() || FALLBACK.name,
        short_name: (d.short_name || '').trim() || FALLBACK.short_name,
        logo_url: (d.logo_url || '').trim() || FALLBACK.logo_url,
        favicon_url: (d.favicon_url || '').trim() || (d.logo_url || '').trim() || FALLBACK.favicon_url,
        app_icon_url: (d.app_icon_url || '').trim(),
        app_ico_url: (d.app_ico_url || '').trim(),
        revision: Number(d.revision) || 0,
        loaded: true,
      });
      get().applyDocument();
    } catch {
      set({ loaded: true });
      get().applyDocument();
    }
  },
}));
