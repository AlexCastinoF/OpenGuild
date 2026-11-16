/**
 * themes.ts — Definições de temas prontos do RallyDesk
 * Conjuntos de tokens (--bg, --rail, --side, --main, --members, --accent)
 * Novos temas podem ser adicionados como uma nova entrada na lista THEME_PRESETS.
 */

export interface ThemePreset {
  id: string;
  name: string;
  tag: string;
  bg: string;
  rail: string;
  side: string;
  main: string;
  members: string;
  accent: string;
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'padrao',
    name: 'Padrão',
    tag: 'Padrão',
    bg: '#060b16',
    rail: '#0d182b',
    side: '#0d182b',
    main: '#0b1424',
    members: '#0d182b',
    accent: '#ff9a3d',
  },
  {
    id: 'halloween',
    name: 'Halloween',
    tag: 'Sazonal',
    bg: '#0b0610',
    rail: '#1f1029',
    side: '#1f1029',
    main: '#160a1f',
    members: '#1f1029',
    accent: '#ff7a1a',
  },
  {
    id: 'natal',
    name: 'Natal',
    tag: 'Sazonal',
    bg: '#07130c',
    rail: '#123524',
    side: '#123524',
    main: '#0d2a1b',
    members: '#123524',
    accent: '#ff5a5f',
  },
  {
    id: 'pascoa',
    name: 'Páscoa',
    tag: 'Sazonal',
    bg: '#120e1f',
    rail: '#271d40',
    side: '#271d40',
    main: '#1d1632',
    members: '#271d40',
    accent: '#ffd166',
  },
  {
    id: 'sakura',
    name: 'Sakura',
    tag: 'Floral',
    bg: '#150a12',
    rail: '#2a1220',
    side: '#2a1220',
    main: '#200e19',
    members: '#2a1220',
    accent: '#ff8fc0',
  },
  {
    id: 'oceano',
    name: 'Oceano',
    tag: 'Aquático',
    bg: '#04121a',
    rail: '#0a2a3a',
    side: '#0a2a3a',
    main: '#08202d',
    members: '#0a2a3a',
    accent: '#3ad4e0',
  },
  {
    id: 'neon',
    name: 'Neon Cyber',
    tag: 'Cyber',
    bg: '#07060f',
    rail: '#140f2e',
    side: '#140f2e',
    main: '#0e0a22',
    members: '#140f2e',
    accent: '#c4ff3b',
  },
  {
    id: 'floresta',
    name: 'Floresta',
    tag: 'Natureza',
    bg: '#07140f',
    rail: '#0f2a20',
    side: '#0f2a20',
    main: '#0a1f18',
    members: '#0f2a20',
    accent: '#3ddc97',
  },
];

/**
 * Cálculo do Domingo de Páscoa no calendário gregoriano (Algoritmo de Meeus/Jones/Butcher)
 */
export function getEasterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1; // 0-indexed (2 = março, 3 = abril)
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month, day);
}

/**
 * Determina se hoje está dentro de uma data especial configurada:
 * - Halloween: 20 a 31 de Outubro
 * - Natal: 1 a 26 de Dezembro
 * - Páscoa: de 7 dias antes do Domingo de Páscoa até o próprio Domingo de Páscoa
 */
export function getActiveSeasonalPreset(now = new Date()): ThemePreset | null {
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed
  const day = now.getDate();

  // Halloween: 20 a 31 de Outubro (mês 9)
  if (month === 9 && day >= 20 && day <= 31) {
    return THEME_PRESETS.find((t) => t.id === 'halloween') || null;
  }

  // Natal: 1 a 26 de Dezembro (mês 11)
  if (month === 11 && day >= 1 && day <= 26) {
    return THEME_PRESETS.find((t) => t.id === 'natal') || null;
  }

  // Páscoa: de 7 dias antes até o Domingo de Páscoa
  const easter = getEasterSunday(year);
  const easterStart = new Date(easter);
  easterStart.setDate(easter.getDate() - 7);
  easterStart.setHours(0, 0, 0, 0);

  const easterEnd = new Date(easter);
  easterEnd.setHours(23, 59, 59, 999);

  if (now >= easterStart && now <= easterEnd) {
    return THEME_PRESETS.find((t) => t.id === 'pascoa') || null;
  }

  return null;
}

/**
 * Verifica se um conjunto de tokens corresponde exatamente a um dos temas prontos
 */
export function findMatchingPreset(colors: {
  bg: string;
  rail: string;
  side: string;
  main: string;
  members: string;
  accent: string;
}): ThemePreset | null {
  const norm = (c: string) => c.toLowerCase().trim();
  return (
    THEME_PRESETS.find(
      (t) =>
        norm(t.bg) === norm(colors.bg) &&
        norm(t.rail) === norm(colors.rail) &&
        norm(t.side) === norm(colors.side) &&
        norm(t.main) === norm(colors.main) &&
        norm(t.members) === norm(colors.members) &&
        norm(t.accent) === norm(colors.accent),
    ) || null
  );
}
