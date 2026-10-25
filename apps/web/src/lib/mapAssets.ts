/** Assets de mapa para veto / lobby. Cache-bust quando as fotos mudarem. */
export const MAP_PHOTO_VERSION = '20260923a';

export const MAP_LABEL: Record<string, string> = {
  ancient: 'Ancient',
  anubis: 'Anubis',
  cache: 'Cache',
  dust2: 'Dust II',
  inferno: 'Inferno',
  mirage: 'Mirage',
  nuke: 'Nuke',
  overpass: 'Overpass',
  train: 'Train',
  vertigo: 'Vertigo',
};

/** Tom de acento por mapa (borda / glow). */
export const MAP_ACCENT: Record<string, string> = {
  ancient: '#5a9e72',
  anubis: '#c9a227',
  cache: '#3d8f6a',
  dust2: '#c4a35a',
  inferno: '#d4783a',
  mirage: '#6bb89a',
  nuke: '#6a9ab8',
  overpass: '#7a8fa3',
  train: '#8a8a8a',
  vertigo: '#5b8fd4',
};

export function mapKey(id: string) {
  return String(id || '')
    .toLowerCase()
    .replace(/^de_/, '')
    .replace(/^cs_/, '');
}

export function mapLabel(id: string) {
  const key = mapKey(id);
  return MAP_LABEL[key] || key || id;
}

export function mapPhoto(id: string) {
  const key = mapKey(id);
  if (!key) return '';
  return `/maps/de_${key}.jpg?v=${MAP_PHOTO_VERSION}`;
}

export function mapAccent(id: string) {
  return MAP_ACCENT[mapKey(id)] || '#8aa0b8';
}
