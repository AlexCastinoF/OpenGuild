/**
 * RallyDesk Appearance & Islands Design System
 * Manages area-based colors, layout styles (islands, continuous, glass),
 * radius, gaps, WCAG contrast validation, and themes preset management.
 */

import {
  ThemePreset,
  THEME_PRESETS,
  getActiveSeasonalPreset,
  findMatchingPreset,
} from './themes';

export type LayoutStyle = 'islands' | 'continuous' | 'glass';

export interface AppearanceSettings {
  bg: string;
  rail: string;
  side: string;
  main: string;
  members: string;
  accent: string;
  layoutStyle: LayoutStyle;
  radius: number; // 0 to 32px (default: 22)
  gap: number; // 0 to 24px (default: 12)
  selectedThemeId?: string; // id do tema ('padrao', 'halloween', etc., ou 'custom')
  autoSpecialDates?: boolean; // Padrão: true ("Trocar nas datas especiais")
}

export const STORAGE_KEY = 'rally-appearance-settings';

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  bg: '#060b16',
  rail: '#0d182b',
  side: '#0d182b',
  main: '#0b1424',
  members: '#0d182b',
  accent: '#ff9a3d',
  layoutStyle: 'islands',
  radius: 22,
  gap: 12,
  selectedThemeId: 'padrao',
  autoSpecialDates: true,
};

export const AREA_SWATCHES = [
  { label: 'Azul Padrão', value: '#0d182b' },
  { label: 'Grafite', value: '#1a1a1a' },
  { label: 'Índigo', value: '#17143a' },
  { label: 'Floresta', value: '#0f2a20' },
  { label: 'Vinho', value: '#2a1220' },
  { label: 'Oceano', value: '#0a2a3a' },
  { label: 'Cyber', value: '#140f2e' },
];

export const BG_SWATCHES = [
  { label: 'Azul Noturno', value: '#060b16' },
  { label: 'Preto Puro', value: '#050508' },
  { label: 'Índigo Profundo', value: '#0b0610' },
  { label: 'Floresta Escura', value: '#07140f' },
  { label: 'Vinho Profundo', value: '#150a12' },
  { label: 'Oceano Profundo', value: '#04121a' },
];

export const ACCENT_SWATCHES = [
  { label: 'Laranja (CS2)', value: '#ff9a3d' },
  { label: 'Azul Turquesa', value: '#3ad4e0' },
  { label: 'Verde Neon', value: '#c4ff3b' },
  { label: 'Verde Floresta', value: '#3ddc97' },
  { label: 'Rosa Sakura', value: '#ff8fc0' },
  { label: 'Amarelo Ouro', value: '#ffd166' },
  { label: 'Vermelho Natal', value: '#ff5a5f' },
  { label: 'Laranja Halloween', value: '#ff7a1a' },
];

/** Calculates relative luminance according to WCAG 2.1 specifications */
export function getLuminance(hex: string): number {
  const clean = hex.replace('#', '').trim();
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;

  if (full.length < 6) return 0.2;

  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;

  const toLinear = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Contrast ratio between two hex colors */
export function getContrastRatio(hex1: string, hex2: string): number {
  const lum1 = getLuminance(hex1);
  const lum2 = getLuminance(hex2);
  const bright = Math.max(lum1, lum2);
  const dark = Math.min(lum1, lum2);
  return (bright + 0.05) / (dark + 0.05);
}

/** Check if text color has >= 4.5:1 contrast against a background */
export function isContrastAdequate(bgColor: string, textColor = '#e8eef9'): boolean {
  return getContrastRatio(bgColor, textColor) >= 4.5;
}

/** Read synchronously from localStorage with seasonal date fallback */
export function getSavedAppearance(): AppearanceSettings {
  if (typeof window === 'undefined') return DEFAULT_APPEARANCE;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<AppearanceSettings>) : null;
    const base: AppearanceSettings = {
      ...DEFAULT_APPEARANCE,
      ...(parsed || {}),
    };

    // "Trocar nas datas especiais": se ligado (default: true), aplicar automaticamente
    // Halloween (20 a 31 out), Natal (1 a 26 dez) e Páscoa (de 7 dias antes até o domingo).
    // Fora dessas datas, voltar ao tema escolhido pelo usuário.
    if (base.autoSpecialDates !== false) {
      const seasonal = getActiveSeasonalPreset();
      if (seasonal) {
        return {
          ...base,
          bg: seasonal.bg,
          rail: seasonal.rail,
          side: seasonal.side,
          main: seasonal.main,
          members: seasonal.members,
          accent: seasonal.accent,
          selectedThemeId: seasonal.id,
        };
      }
    }

    return base;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/** Apply CSS variables directly to document.documentElement and document.body */
export function applyAppearance(settings: AppearanceSettings) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const body = document.body;

  const isContinuous = settings.layoutStyle === 'continuous';
  const isGlass = settings.layoutStyle === 'glass';

  const effectiveRadius = isContinuous ? '0px' : `${settings.radius ?? 22}px`;
  const effectiveGap = isContinuous ? '0px' : `${settings.gap ?? 12}px`;

  const onAccent = getLuminance(settings.accent) > 0.45 ? '#04101f' : '#ffffff';
  const islandBorder = isContinuous ? 'none' : '1px solid rgba(255, 255, 255, 0.06)';
  const islandShadow = isContinuous ? 'none' : '0 10px 30px rgba(0, 0, 0, 0.35)';

  const targets = [root, body].filter(Boolean) as HTMLElement[];

  targets.forEach((target) => {
    // Root design tokens
    target.style.setProperty('--bg', settings.bg);
    target.style.setProperty('--rail', settings.rail);
    target.style.setProperty('--side', settings.side);
    target.style.setProperty('--main', settings.main);
    target.style.setProperty('--members', settings.members);
    target.style.setProperty('--accent', settings.accent);
    target.style.setProperty('--on-accent', onAccent);

    target.style.setProperty('--radius', effectiveRadius);
    target.style.setProperty('--gap', effectiveGap);

    // Overlay colors
    target.style.setProperty('--hover', 'rgba(255, 255, 255, 0.05)');
    target.style.setProperty('--active', 'rgba(255, 255, 255, 0.08)');
    target.style.setProperty('--text', '#e8eef9');
    target.style.setProperty('--text-muted', '#8ea2c0');
    target.style.setProperty('--text-dim', '#6f84a5');
    target.style.setProperty('--online', '#3ddc97');

    // Island styles
    target.style.setProperty('--island-border', islandBorder);
    target.style.setProperty('--island-shadow', islandShadow);

    if (isGlass) {
      target.style.setProperty('--glass-blur', 'blur(20px)');
      target.style.setProperty('--island-bg-opacity', '0.78');
    } else {
      target.style.setProperty('--glass-blur', 'none');
      target.style.setProperty('--island-bg-opacity', '1');
    }

    // Map to legacy variables so existing components seamlessly inherit the new appearance
    target.style.setProperty('--comm-accent', settings.accent);
    target.style.setProperty('--comm-accent-hover', settings.accent);
    target.style.setProperty('--comm-bg0', settings.bg);
    target.style.setProperty('--comm-bg1', settings.side);
    target.style.setProperty('--comm-bg2', settings.main);
    target.style.setProperty('--comm-bg3', settings.main);
    target.style.setProperty('--comm-panel', settings.side);
    target.style.setProperty('--comm-panel-2', settings.rail);
    target.style.setProperty('--comm-line', 'rgba(255, 255, 255, 0.06)');

    // Tag layout style class for specialized CSS hooks
    target.classList.remove('layout-islands', 'layout-continuous', 'layout-glass');
    target.classList.add(`layout-${settings.layoutStyle}`);
  });
}

/** Synchronous bootstrap helper called immediately before React renders */
export function bootstrapAppearance() {
  const current = getSavedAppearance();
  applyAppearance(current);
}
