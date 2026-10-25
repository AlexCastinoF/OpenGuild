/** Veto estilo CS2 Premier + roster simulado para teste a solo. */

export const COMP_MAPS = [
  'ancient',
  'anubis',
  'cache',
  'dust2',
  'inferno',
  'mirage',
  'nuke',
  'overpass',
  'train',
  'vertigo',
] as const;

export type CompMap = (typeof COMP_MAPS)[number];

export type VetoPhaseKind = 'ban' | 'pick_side' | 'done';

export type VetoSlice = {
  kind: VetoPhaseKind;
  count: number;
  team: 'CT' | 'T';
  label: string;
};

export type MatchVeto = {
  slices: VetoSlice[];
  sliceIndex: number;
  remainingInSlice: number;
  turnTeam: 'CT' | 'T';
  mapsLeft: string[];
  bans: Array<{ map: string; team: 'CT' | 'T' }>;
  turnEndsAt: number;
  startingSide: '' | 'CT' | 'T';
  /** Um único jogador (humano) escolhe o lado; 0 = auto/bot. */
  pickerUserId: number;
  simulated: boolean;
};

export type RadarByTeam = Record<'CT' | 'T', Record<string, number>>;

const BOT_NAMES_A = ['LimaBOMB', 'Hallows', 'Wraith', "Grandma's Pie", 'hopscotch'];
const BOT_NAMES_B = ['apex.', 'n0thing', 's1mple', 'device', 'NiKo'];

export function parseFormat(format: string) {
  const m = String(format || '5v5').match(/(\d+)\s*v\s*(\d+)/i);
  const a = Math.max(1, Math.min(5, Number(m?.[1] || 5)));
  const b = Math.max(1, Math.min(5, Number(m?.[2] || 5)));
  return { a, b };
}

export function banSlices(mapCount: number, firstTeam: 'CT' | 'T'): VetoSlice[] {
  let left = Math.max(0, mapCount - 1);
  const slices: VetoSlice[] = [];
  let team = firstTeam;
  let step = 0;
  if (left >= 2) {
    slices.push({ kind: 'ban', count: 2, team, label: 'Ban 2 Maps' });
    left -= 2;
    team = team === 'CT' ? 'T' : 'CT';
    step += 1;
  }
  if (left >= 3) {
    slices.push({ kind: 'ban', count: 3, team, label: 'Ban 3 Maps' });
    left -= 3;
    team = team === 'CT' ? 'T' : 'CT';
    step += 1;
  }
  while (left > 0) {
    const n = Math.min(left === 1 ? 1 : 2, left);
    slices.push({
      kind: 'ban',
      count: n,
      team,
      label: n === 1 ? 'Ban 1 Map' : `Ban ${n} Maps`,
    });
    left -= n;
    team = team === 'CT' ? 'T' : 'CT';
    step += 1;
  }
  slices.push({ kind: 'pick_side', count: 1, team, label: 'Lado inicial' });
  slices.push({ kind: 'done', count: 0, team, label: 'Start Match' });
  return slices;
}

export function stableRadar(seed: string, maps: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  for (const map of maps) {
    h ^= map.charCodeAt(0) + map.length * 31;
    h = Math.imul(h, 16777619);
    const u = ((h >>> 0) % 1000) / 1000;
    out[map] = Math.round((0.28 + u * 0.62) * 100) / 100;
  }
  return out;
}

/** Radar vazio (centro) — sem histórico. */
export function emptyRadar(maps: readonly string[] = COMP_MAPS): Record<string, number> {
  const out: Record<string, number> = {};
  for (const map of maps) out[map] = 0;
  return out;
}

export function makeRadar(maps: readonly string[] = COMP_MAPS): RadarByTeam {
  return {
    CT: emptyRadar(maps),
    T: emptyRadar(maps),
  };
}

/** Média de winrates 0–1 por mapa (0 = nunca jogou). */
export function radarFromWinrates(
  maps: readonly string[],
  perPlayer: Array<Record<string, { wins: number; losses: number }>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const map of maps) {
    let sum = 0;
    let n = 0;
    for (const row of perPlayer) {
      const s = row[map];
      if (!s) continue;
      const total = (s.wins || 0) + (s.losses || 0);
      if (total <= 0) continue;
      sum += (s.wins || 0) / total;
      n += 1;
    }
    out[map] = n > 0 ? Math.round((sum / n) * 100) / 100 : 0;
  }
  return out;
}

export function playerRating(userId: number) {
  const n = Math.abs(Number(userId) || 0);
  const h = Math.abs(Math.imul(n ^ 0x9e3779b9, 1103515245) + 12345) >>> 0;
  return 6500 + (h % 88500);
}

export function shuffleInPlace<T>(arr: T[]) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

export function botPlayer(opts: {
  userId: number;
  displayName: string;
  ready?: boolean;
}): {
  userId: number;
  username: string;
  displayName: string;
  avatarUrl: string;
  team: '';
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  inviteStatus: 'accepted';
  simulated: boolean;
  rating: number;
} {
  return {
    userId: opts.userId,
    username: opts.displayName.toLowerCase().replace(/\W+/g, ''),
    displayName: opts.displayName,
    avatarUrl: '',
    team: '',
    ready: opts.ready !== false,
    connected: false,
    isHost: false,
    inviteStatus: 'accepted',
    simulated: true,
    rating: playerRating(opts.userId),
  };
}

export function simulatedBots(hostUserId: number, count: number) {
  const names = [...BOT_NAMES_A, ...BOT_NAMES_B];
  const n = Math.max(0, count);
  const bots = [];
  for (let i = 0; i < n; i += 1) {
    bots.push(
      botPlayer({
        userId: -90000 - hostUserId * 10 - i,
        displayName: names[i % names.length] + (i >= names.length ? ` ${i}` : ''),
      }),
    );
  }
  return bots;
}

export const TURN_MS = 20000;
export const SIM_TURN_MS = 1600;

type SidePlayer = {
  userId: number;
  team: 'CT' | 'T' | 'SPEC' | '';
  simulated?: boolean;
  inviteStatus?: string;
};

/** Um time aleatório, uma pessoa aleatória desse time — só esse humano vê o pick de lado. */
export function chooseSidePicker(players: SidePlayer[]): { team: 'CT' | 'T'; userId: number } | null {
  const humans = players.filter(
    (p) =>
      p.userId > 0 &&
      !p.simulated &&
      (p.inviteStatus === 'host' || p.inviteStatus === 'accepted' || !p.inviteStatus) &&
      (p.team === 'CT' || p.team === 'T'),
  );
  if (!humans.length) return null;
  const teams = [...new Set(humans.map((p) => p.team))] as Array<'CT' | 'T'>;
  const team = teams[Math.floor(Math.random() * teams.length)];
  const pool = humans.filter((p) => p.team === team);
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return pick ? { team, userId: pick.userId } : null;
}

/** O lado escolhido é o do time do picker — se não bater, troca CT↔TR. */
export function applyStartingSideSwap(
  players: Array<{ team: 'CT' | 'T' | 'SPEC' | '' }>,
  pickerTeam: 'CT' | 'T' | '' | undefined,
  startingSide: 'CT' | 'T',
) {
  if (pickerTeam !== 'CT' && pickerTeam !== 'T') return;
  if (pickerTeam === startingSide) return;
  for (const p of players) {
    if (p.team === 'CT') p.team = 'T';
    else if (p.team === 'T') p.team = 'CT';
  }
}
