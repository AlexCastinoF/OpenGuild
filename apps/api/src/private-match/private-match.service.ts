import { randomBytes } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { PresenceService } from '../presence/presence.service';
import { CommunityService } from '../community/community.service';
import { Cs2TunnelService } from './cs2-tunnel.service';
import { clearMatchVoiceAcl, setMatchVoiceAcl } from './match-voice-acl';

export type MatchMode = 'valve' | 'host_listen';
export type MatchStatus =
  | 'lobby'
  | 'voting'
  | 'host_booting'
  | 'connecting'
  | 'live'
  | 'ended';

export type MatchPlayer = {
  userId: number;
  username: string;
  displayName: string;
  avatarUrl: string;
  /** SteamID64 ligado à conta (para o dedicated atribuir CT/TR). */
  steamid?: string;
  team: 'CT' | 'T' | 'SPEC' | '';
  ready: boolean;
  connected: boolean;
  /** Está no dedicated agora (host reporta via snapshot). */
  inServer?: boolean;
  /** health>0 no GSI; null = desconhecido. */
  alive?: boolean | null;
  health?: number | null;
  /** Time in-game (GSI/status), pode diferir do lobby. */
  gameTeam?: 'CT' | 'T' | 'SPEC' | '';
  isHost: boolean;
  inviteStatus: 'host' | 'accepted' | 'pending' | 'declined';
  simulated?: boolean;
  rating?: number;
  previousVoiceChannelId?: number;
};

export type MatchConnect = {
  host: string;
  port: number;
  password: string;
  connectString: string;
  map: string;
};

export type MatchStatsRow = {
  userId: number;
  steamid?: string;
  name: string;
  team: string;
  kills: number;
  assists: number;
  deaths: number;
  hs?: number;
  adr?: number;
  fk?: number;
  fd?: number;
  plants?: number;
  defuses?: number;
  at: number;
};

export type PrivateMatch = {
  id: string;
  serverId: number;
  mode: MatchMode;
  status: MatchStatus;
  name: string;
  roomPassword: string;
  format: string;
  mr: number;
  overtime: boolean;
  hostUserId: number;
  mapPool: string[];
  votes: Record<string, string>; // userId -> mapId
  votedMap: string;
  voteEndsAt: number;
  veto: import('./match-veto').MatchVeto | null;
  radarByTeam: import('./match-veto').RadarByTeam;
  voiceChannels?: { CT?: number; T?: number; SPEC?: number };
  canJoin?: boolean;
  canWatch?: boolean;
  isMember?: boolean;
  youPending?: boolean;
  /** Countdown após todos ready; 0 = inativo */
  readyCountdownEndsAt: number;
  /** Fase de boot partilhada (host_booting / connecting) */
  bootPhase: string;
  bootMessage: string;
  connect: MatchConnect | null;
  players: MatchPlayer[];
  scoreCt: number;
  scoreT: number;
  round: number;
  stats: MatchStatsRow[];
  feed: Array<{ t: string; type: string; text: string; at: number }>;
  createdAt: number;
  updatedAt: number;
  /** Últimas cvars aplicadas pelo host (UI sync). */
  adminSettings?: Record<string, number | undefined>;
  /** Pack remoto SfAssignTeams (versão semântica) escolhido pelo host. */
  matchPackVersion?: string;
  /** Mensagem de boas-vindas / sistema no chat ao iniciar. */
  welcomeMessage?: string;
  /** Cor da mensagem no chat CS2 (green, lime, yellow, …). */
  welcomeColor?: string;
  /** Evita spam da mensagem de sistema no chat do servidor. */
  systemChatPosted?: boolean;
};

import {
  COMP_MAPS,
  SIM_TURN_MS,
  TURN_MS,
  applyStartingSideSwap,
  banSlices,
  chooseSidePicker,
  makeRadar,
  parseFormat,
  playerRating,
  radarFromWinrates,
  shuffleInPlace,
  simulatedBots,
} from './match-veto';

const MAP_POOL = [...COMP_MAPS];

function newId() {
  return randomBytes(8).toString('hex');
}

function genPassword() {
  return randomBytes(3).toString('hex');
}

const WELCOME_COLORS = new Set([
  'green',
  'lime',
  'yellow',
  'lightblue',
  'white',
  'olive',
  'gold',
  'lightpurple',
]);

function normalizeWelcomeColor(raw?: string) {
  const c = String(raw || 'green').trim().toLowerCase();
  return WELCOME_COLORS.has(c) ? c : 'green';
}

@Injectable()
export class PrivateMatchService {
  /** In-memory (local). Persistência Prisma numa fase seguinte. */
  private matches = new Map<string, PrivateMatch>();
  private timers = new Map<string, NodeJS.Timeout>();
  private ratings = new Map<number, number>();
  private records: Array<{
    id: string;
    serverId: number;
    name: string;
    map: string;
    format: string;
    scoreCt: number;
    scoreT: number;
    endedAt: number;
    players: unknown;
  }> = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly tunnel: Cs2TunnelService,
    private readonly presence: PresenceService,
    private readonly community: CommunityService,
  ) {}

  async loadRating(userId: number) {
    if (userId < 0) return playerRating(userId);
    const cached = this.ratings.get(userId);
    if (typeof cached === 'number') return cached;
    try {
      const row = await this.prisma.privateMatchRating.findUnique({ where: { userId } });
      const seed = typeof row?.rating === 'number' ? row.rating : 0;
      this.ratings.set(userId, seed);
      return seed;
    } catch {
      this.ratings.set(userId, 0);
      return 0;
    }
  }

  private async saveRating(userId: number, rating: number) {
    if (userId < 0) return;
    const clamped = Math.max(0, Math.min(100000, Math.round(rating)));
    this.ratings.set(userId, clamped);
    try {
      await this.prisma.privateMatchRating.upsert({
        where: { userId },
        create: { userId, rating: clamped, updatedAt: Date.now() / 1000 },
        update: { rating: clamped, updatedAt: Date.now() / 1000 },
      });
    } catch (err) {
      console.warn('[private-match] saveRating', err);
    }
  }

  private async loadMapStats(
    userId: number,
  ): Promise<Record<string, { wins: number; losses: number }>> {
    if (userId < 0) return {};
    try {
      const rows = await this.prisma.privateMatchMapStat.findMany({ where: { userId } });
      const out: Record<string, { wins: number; losses: number }> = {};
      for (const r of rows) out[r.map] = { wins: r.wins, losses: r.losses };
      return out;
    } catch {
      return {};
    }
  }

  private async bumpMapStat(userId: number, map: string, won: boolean) {
    if (userId < 0 || !map) return;
    const key = String(map).replace(/^de_/, '').toLowerCase();
    try {
      const existing = await this.prisma.privateMatchMapStat.findUnique({
        where: { userId_map: { userId, map: key } },
      });
      const wins = (existing?.wins || 0) + (won ? 1 : 0);
      const losses = (existing?.losses || 0) + (won ? 0 : 1);
      await this.prisma.privateMatchMapStat.upsert({
        where: { userId_map: { userId, map: key } },
        create: { userId, map: key, wins, losses, updatedAt: Date.now() / 1000 },
        update: { wins, losses, updatedAt: Date.now() / 1000 },
      });
    } catch (err) {
      console.warn('[private-match] bumpMapStat', err);
    }
  }

  /** Pontos da partida: kills/HS/streak/vitória (só sobe). */
  private scoreDeltaForPlayer(
    p: MatchPlayer,
    m: PrivateMatch,
    won: boolean,
    draw: boolean,
  ): number {
    const st = (m.stats || []).find((s) => {
      if (s.userId > 0 && s.userId === p.userId) return true;
      const sid = String(s.steamid || '').replace(/\D/g, '');
      const ps = String(p.steamid || '').replace(/\D/g, '');
      if (sid && ps && sid === ps) return true;
      const nm = String(s.name || '').trim().toLowerCase();
      const pn = (p.displayName || p.username || '').trim().toLowerCase();
      return !!(nm && pn && nm === pn);
    });
    const kills = Number(st?.kills) || 0;
    let hs = Number(st?.hs) || 0;
    const names = new Set(
      [p.displayName, p.username, st?.name]
        .map((x) => String(x || '').trim().toLowerCase())
        .filter(Boolean),
    );
    let streak = 0;
    let bestStreak = 0;
    const feed = [...(m.feed || [])].sort((a, b) => (a.at || 0) - (b.at || 0));
    for (const f of feed) {
      const text = String(f.text || '');
      const low = text.toLowerCase();
      const type = String(f.type || '').toLowerCase();
      const isKill = type === 'kill' || /killed|matou|☠|💀/i.test(text);
      const isDeath = type === 'death' || /foi morto|died|morreu/i.test(text);
      const mentions = [...names].some((n) => n && low.includes(n));
      if (!mentions && !isKill && !isDeath) continue;
      // Heurística: "A matou B" / "A killed B"
      const killerMatch = text.match(/^([^:\-–]+?)\s+(?:matou|killed|✖)/i);
      const killer = killerMatch?.[1]?.trim().toLowerCase() || '';
      const victimMatch = text.match(/(?:matou|killed|✖)\s+(.+?)(?:\s+com|\s+with|$)/i);
      const victim = victimMatch?.[1]?.trim().toLowerCase() || '';
      const iAmKiller = killer && [...names].some((n) => killer.includes(n) || n.includes(killer));
      const iAmVictim = victim && [...names].some((n) => victim.includes(n) || n.includes(victim));
      if (iAmKiller || (isKill && mentions && !iAmVictim)) {
        streak += 1;
        bestStreak = Math.max(bestStreak, streak);
        if (/\bhs\b|headshot|cabeça/i.test(text)) hs += 1;
      } else if (iAmVictim || (isDeath && mentions)) {
        streak = 0;
      }
    }
    // Evitar double-count HS se stats.hs já veio do GSI
    if (Number(st?.hs) > 0) hs = Number(st?.hs) || 0;

    let pts = kills * 10 + hs * 5;
    if (bestStreak >= 7) pts += 50;
    else if (bestStreak >= 5) pts += 30;
    else if (bestStreak >= 3) pts += 15;
    if (won && !draw) pts += 100;
    return pts;
  }

  private get(id: string): PrivateMatch {
    const m = this.matches.get(id);
    if (!m) throw new NotFoundException({ ok: false, error: 'match_not_found' });
    return m;
  }

  private player(m: PrivateMatch, userId: number) {
    return m.players.find((p) => p.userId === userId);
  }

  private requirePlayer(m: PrivateMatch, userId: number) {
    const p = this.player(m, userId);
    if (!p || p.inviteStatus === 'declined' || p.inviteStatus === 'pending') {
      throw new ForbiddenException({ ok: false, error: 'not_in_match' });
    }
    return p;
  }

  private touch(m: PrivateMatch) {
    m.updatedAt = Date.now();
  }

  private clearTimer(id: string) {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

  private viewFor(m: PrivateMatch, userId: number) {
    const copy = JSON.parse(JSON.stringify(m)) as PrivateMatch & {
      serverNow: number;
      radar?: Record<string, number>;
      radarCt?: Record<string, number>;
      radarT?: Record<string, number>;
      teamRating: { CT: number; T: number };
    };
    copy.serverNow = Date.now();
    copy.radarCt = m.radarByTeam?.CT || {};
    copy.radarT = m.radarByTeam?.T || {};
    const me = copy.players.find((p) => p.userId === userId);
    const myTeam = me?.team || '';
    copy.radar = myTeam ? m.radarByTeam?.[myTeam as 'CT' | 'T'] || {} : copy.radarCt;
    const sumTeam = (team: 'CT' | 'T') =>
      copy.players
        .filter((p) => p.team === team && p.inviteStatus !== 'declined')
        .reduce((s, p) => s + (typeof p.rating === 'number' ? p.rating : playerRating(p.userId)), 0);
    copy.teamRating = { CT: sumTeam('CT'), T: sumTeam('T') };
    if (copy.status === 'voting') {
      for (const p of copy.players) {
        p.displayName = '*******';
        p.username = '*******';
        p.avatarUrl = '';
        delete p.rating;
      }
    }
    delete (copy as { radarByTeam?: unknown }).radarByTeam;
    return copy;
  }

  private payload(m: PrivateMatch, userId?: number) {
    if (userId) return { ok: true as const, match: this.viewFor(m, userId) };
    return { ok: true as const, match: this.viewFor(m, m.hostUserId) };
  }

  private emitMatch(m: PrivateMatch, event: string, extra: Record<string, unknown> = {}) {
    for (const p of m.players) {
      if (p.inviteStatus === 'declined' || p.userId < 0) continue;
      this.realtime.emitToUser(p.userId, event, {
        match: this.viewFor(m, p.userId),
        ...extra,
      });
    }
    this.realtime.emitToServer(m.serverId, event, extra);
    this.realtime.emitToServer(m.serverId, 'match.rooms', { room: this.publicRoom(m) });
  }

  private publicRoom(m: PrivateMatch) {
    const players = m.players.filter((p) => p.inviteStatus !== 'declined');
    return {
      id: m.id,
      serverId: m.serverId,
      name: m.name,
      status: m.status,
      mode: m.mode,
      format: m.format,
      scoreCt: m.scoreCt,
      scoreT: m.scoreT,
      round: m.round,
      votedMap: m.votedMap,
      updatedAt: m.updatedAt,
      playerCount: players.filter((p) => p.team !== 'SPEC').length,
      spectatorCount: players.filter((p) => p.team === 'SPEC').length,
      voiceChannels: m.voiceChannels || {},
    };
  }

  private roomFlags(m: PrivateMatch, userId: number) {
    const you = this.player(m, userId);
    const isMember = !!(
      you &&
      (you.inviteStatus === 'host' || you.inviteStatus === 'accepted')
    );
    const youPending = you?.inviteStatus === 'pending';
    const live = m.status === 'live' || m.status === 'connecting' || m.status === 'host_booting';
    return {
      isMember,
      youPending: !!youPending,
      canJoin: !!youPending,
      canWatch: live,
    };
  }

  private async userBrief(userId: number) {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        steamId64: true,
      },
    });
    if (!u) throw new BadRequestException({ ok: false, error: 'user_not_found' });
    return u;
  }

  private async requireSteamLinked(userId: number) {
    const u = await this.userBrief(userId);
    const sid = (u.steamId64 || '').trim();
    if (!sid) {
      throw new BadRequestException({
        ok: false,
        error: 'steam_required',
        message: 'Liga a tua conta Steam para jogar Partidas CS2.',
      });
    }
    return u;
  }

  private async enrichSteamIds(m: PrivateMatch) {
    for (const p of m.players) {
      if (p.userId < 0 || p.simulated) continue;
      if ((p.steamid || '').trim()) continue;
      try {
        const u = await this.userBrief(p.userId);
        p.steamid = (u.steamId64 || '').trim();
      } catch {
        /* ignore */
      }
    }
  }

  listForUser(userId: number) {
    const list = [...this.matches.values()]
      .filter(
        (m) =>
          m.status !== 'ended' &&
          m.players.some(
            (p) =>
              p.userId === userId &&
              (p.inviteStatus === 'host' ||
                p.inviteStatus === 'accepted' ||
                p.inviteStatus === 'pending'),
          ),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return { ok: true, matches: list };
  }

  /** Salas abertas neste servidor da comunidade (hub Partidas). */
  listForServer(serverId: number, userId?: number) {
    const list = [...this.matches.values()]
      .filter((m) => m.serverId === serverId && m.status !== 'ended')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((m) => {
        const flags = userId
          ? this.roomFlags(m, userId)
          : { isMember: false, youPending: false, canJoin: false, canWatch: false };
        const view = userId && flags.isMember ? this.viewFor(m, userId) : {
          ...this.publicRoom(m),
          players: m.players
            .filter((p) => p.inviteStatus !== 'declined')
            .map((p) => ({
              userId: p.userId,
              username: m.status === 'voting' ? '*******' : p.username,
              displayName: m.status === 'voting' || !flags.isMember ? '*******' : p.displayName,
              avatarUrl: m.status === 'voting' || !flags.isMember ? '' : p.avatarUrl,
              team: p.team,
              ready: p.ready,
              connected: p.connected,
              isHost: p.isHost,
              inviteStatus: p.inviteStatus,
              simulated: p.simulated,
              rating: undefined,
            })),
          votes: {},
          roomPassword: '',
          connect: null,
          stats: m.status === 'live' || m.status === 'connecting' ? m.stats : [],
          feed: [],
          hostUserId: m.hostUserId,
          mapPool: m.mapPool,
          votedMap: m.votedMap,
          voteEndsAt: 0,
          mr: m.mr,
          overtime: m.overtime,
          scoreCt: m.scoreCt,
          scoreT: m.scoreT,
          round: m.round,
        };
        return { ...view, ...flags };
      });
    return { ok: true, matches: list };
  }

  getMatch(userId: number, id: string) {
    const m = this.get(id);
    const p = this.player(m, userId);
    if (!p) throw new ForbiddenException({ ok: false, error: 'not_in_match' });
    return this.payload(m, userId);
  }

  async create(opts: {
    hostUserId: number;
    serverId: number;
    mode: MatchMode;
    name?: string;
    roomPassword?: string;
    format?: string;
    mr?: number;
    overtime?: boolean;
    inviteUserIds?: number[];
    adminSettings?: NonNullable<PrivateMatch['adminSettings']>;
    matchPackVersion?: string;
    welcomeMessage?: string;
    welcomeColor?: string;
  }) {
    const host = await this.requireSteamLinked(opts.hostUserId);
    const id = newId();
    const roomPassword = String(opts.roomPassword || '').trim() || genPassword();
    const welcome = String(opts.welcomeMessage || '').trim().slice(0, 200);
    const welcomeColor = normalizeWelcomeColor(opts.welcomeColor);
    const packVer = String(opts.matchPackVersion || '')
      .trim()
      .slice(0, 32);
    const m: PrivateMatch = {
      id,
      serverId: opts.serverId,
      mode: opts.mode === 'host_listen' ? 'host_listen' : 'valve',
      status: 'lobby',
      name: String(opts.name || 'Partida privada').trim().slice(0, 64) || 'Partida privada',
      roomPassword,
      format: String(opts.format || '5v5').slice(0, 8),
      mr: opts.mr === 15 || opts.mr === 8 ? opts.mr : 12,
      overtime: opts.overtime !== false,
      hostUserId: opts.hostUserId,
      mapPool: [...MAP_POOL],
      votes: {},
      votedMap: '',
      voteEndsAt: 0,
      veto: null,
      radarByTeam: makeRadar(),
      readyCountdownEndsAt: 0,
      bootPhase: '',
      bootMessage: '',
      connect: null,
      players: [
        {
          userId: host.id,
          username: host.username,
          displayName: host.displayName || host.username,
          avatarUrl: host.avatarUrl || '',
          steamid: (host.steamId64 || '').trim(),
          team: '',
          ready: false,
          connected: false,
          inServer: false,
          alive: null,
          isHost: true,
          inviteStatus: 'host',
          rating: await this.loadRating(host.id),
        },
      ],
      scoreCt: 0,
      scoreT: 0,
      round: 0,
      stats: [],
      feed: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      adminSettings: opts.adminSettings
        ? { ...opts.adminSettings }
        : {
            mp_startmoney: 800,
            mp_roundtime: 1.92,
            mp_freezetime: 15,
            mp_buytime: 20,
            mp_limitteams: 0,
            mp_spectators: 1,
          },
      matchPackVersion: /^\d+\.\d+\.\d+$/.test(packVer) ? packVer : undefined,
      welcomeMessage: welcome || 'Partida Privada Castino.Tech',
      welcomeColor,
    };
    this.matches.set(id, m);

    const invites = [...new Set((opts.inviteUserIds || []).map(Number).filter((n) => n > 0 && n !== opts.hostUserId))];
    for (const tid of invites) {
      try {
        await this.invite(opts.hostUserId, id, tid);
      } catch {
        /* skip invalid */
      }
    }

    const cur = this.get(id);
    this.syncSimulatedRoster(cur);

    this.emitMatch(cur, 'match.updated');
    return this.payload(cur, opts.hostUserId);
  }

  /** Humanos presentes na partida (host/accepted; não bot, não pending/declined). */
  private humanMembers(m: PrivateMatch) {
    return m.players.filter(
      (p) =>
        p.userId > 0 &&
        !p.simulated &&
        (p.inviteStatus === 'host' || p.inviteStatus === 'accepted'),
    );
  }

  /**
   * Bots de veto/lobby só quando há exactamente 1 pessoa (host sozinho).
   * Com 2+ humanos, remove todos os simulados.
   */
  private syncSimulatedRoster(m: PrivateMatch) {
    if (m.status !== 'lobby' && m.status !== 'voting') return;
    const humans = this.humanMembers(m);
    m.players = m.players.filter((p) => !(p.simulated || p.userId < 0));
    if (humans.length !== 1) return;
    const already = m.players.filter((p) => p.inviteStatus !== 'declined').length;
    const { a, b } = parseFormat(m.format);
    const missing = Math.max(0, a + b - already);
    if (missing > 0) {
      m.players.push(...simulatedBots(m.hostUserId, missing));
    }
  }

  /** Entrar numa sala só com convite pendente. */
  async joinLobby(userId: number, matchId: string) {
    await this.requireSteamLinked(userId);
    const m = this.get(matchId);
    if (m.status !== 'lobby' && m.status !== 'voting') {
      throw new BadRequestException({ ok: false, error: 'match_not_open' });
    }
    const existing = this.player(m, userId);
    if (existing) {
      if (existing.inviteStatus === 'pending' || existing.inviteStatus === 'declined') {
        existing.inviteStatus = 'accepted';
        existing.ready = false;
        if (typeof existing.rating !== 'number') existing.rating = await this.loadRating(userId);
        const u = await this.userBrief(userId);
        existing.steamid = (u.steamId64 || '').trim() || existing.steamid;
        this.syncSimulatedRoster(m);
        this.touch(m);
        this.emitMatch(m, 'match.updated');
      }
      return this.payload(m, userId);
    }
    throw new ForbiddenException({ ok: false, error: 'invite_only' });
  }

  async spectate(userId: number, matchId: string) {
    await this.requireSteamLinked(userId);
    const m = this.get(matchId);
    if (m.status === 'ended') {
      throw new BadRequestException({ ok: false, error: 'match_ended' });
    }
    const existing = this.player(m, userId);
    if (existing) {
      if (existing.inviteStatus === 'declined' || existing.inviteStatus === 'pending') {
        existing.inviteStatus = 'accepted';
      }
      existing.team = 'SPEC';
      existing.ready = true;
      this.syncSimulatedRoster(m);
      this.touch(m);
      await this.ensureVoiceChannels(m);
      this.emitMatch(m, 'match.updated');
      return this.payload(m, userId);
    }
    const u = await this.userBrief(userId);
    m.players.push({
      userId: u.id,
      username: u.username,
      displayName: u.displayName || u.username,
      avatarUrl: u.avatarUrl || '',
      steamid: (u.steamId64 || '').trim(),
      team: 'SPEC',
      ready: true,
      connected: false,
      isHost: false,
      inviteStatus: 'accepted',
      rating: await this.loadRating(u.id),
    });
    this.syncSimulatedRoster(m);
    this.touch(m);
    await this.ensureVoiceChannels(m);
    this.emitMatch(m, 'match.updated');
    return this.payload(m, userId);
  }

  async invite(hostUserId: number, matchId: string, targetUserId: number) {
    const m = this.get(matchId);
    if (m.hostUserId !== hostUserId) {
      throw new ForbiddenException({ ok: false, error: 'host_only' });
    }
    if (m.status !== 'lobby' && m.status !== 'voting') {
      throw new BadRequestException({ ok: false, error: 'match_not_open' });
    }
    if (this.player(m, targetUserId)) {
      return this.payload(m);
    }
    const u = await this.userBrief(targetUserId);
    m.players.push({
      userId: u.id,
      username: u.username,
      displayName: u.displayName || u.username,
      avatarUrl: u.avatarUrl || '',
      steamid: (u.steamId64 || '').trim(),
      team: '',
      ready: false,
      connected: false,
      isHost: false,
      inviteStatus: 'pending',
      rating: await this.loadRating(u.id),
    });
    this.syncSimulatedRoster(m);
    this.touch(m);
    this.realtime.emitToUser(targetUserId, 'match.invite', { match: m });
    this.emitMatch(m, 'match.updated');
    return this.payload(m);
  }

  async respondInvite(userId: number, matchId: string, accept: boolean) {
    if (accept) await this.requireSteamLinked(userId);
    const m = this.get(matchId);
    const p = this.player(m, userId);
    if (!p || p.isHost) throw new ForbiddenException({ ok: false, error: 'not_invited' });
    p.inviteStatus = accept ? 'accepted' : 'declined';
    if (accept) {
      p.ready = false;
      const u = await this.userBrief(userId);
      p.steamid = (u.steamId64 || '').trim() || p.steamid;
    }
    this.syncSimulatedRoster(m);
    this.touch(m);
    this.emitMatch(m, accept ? 'match.invite_accepted' : 'match.invite_declined');
    this.emitMatch(m, 'match.updated');
    return this.payload(m);
  }

  async setReady(userId: number, matchId: string, ready: boolean) {
    if (ready) await this.requireSteamLinked(userId);
    const m = this.get(matchId);
    const p = this.requirePlayer(m, userId);
    p.ready = !!ready;
    if (ready) {
      const u = await this.userBrief(userId);
      p.steamid = (u.steamId64 || '').trim() || p.steamid;
    }
    if (!ready) {
      m.readyCountdownEndsAt = 0;
    } else {
      this.maybeStartReadyCountdown(m);
    }
    this.touch(m);
    this.emitMatch(m, 'match.updated');
    return this.payload(m);
  }

  private activePlayers(m: PrivateMatch) {
    return m.players.filter(
      (p) =>
        (p.inviteStatus === 'host' || p.inviteStatus === 'accepted') &&
        p.team !== 'SPEC',
    );
  }

  private maybeStartReadyCountdown(m: PrivateMatch) {
    if (m.status !== 'lobby') return;
    const active = this.activePlayers(m);
    if (active.length < 1) return;
    if (!active.every((p) => p.ready)) {
      m.readyCountdownEndsAt = 0;
      return;
    }
    if (m.readyCountdownEndsAt > Date.now()) return;
    m.readyCountdownEndsAt = Date.now() + 10_000;
    this.emitMatch(m, 'match.ready_countdown', { endsAt: m.readyCountdownEndsAt });
    const id = m.id;
    const ends = m.readyCountdownEndsAt;
    setTimeout(() => {
      try {
        const cur = this.matches.get(id);
        if (!cur || cur.status !== 'lobby' || cur.readyCountdownEndsAt !== ends) return;
        const still = this.activePlayers(cur);
        if (!still.every((p) => p.ready)) {
          cur.readyCountdownEndsAt = 0;
          this.emitMatch(cur, 'match.updated');
          return;
        }
        cur.readyCountdownEndsAt = 0;
        void this.startVote(cur.hostUserId, id);
      } catch {
        /* ignore */
      }
    }, 10_050);
  }

  setBootProgress(
    hostUserId: number,
    matchId: string,
    phase: string,
    message?: string,
  ) {
    const m = this.get(matchId);
    if (m.hostUserId !== hostUserId) {
      throw new ForbiddenException({ ok: false, error: 'host_only' });
    }
    m.bootPhase = String(phase || '').slice(0, 64);
    m.bootMessage = String(message || '').slice(0, 200);
    const becameBooting = m.status === 'lobby' || m.status === 'voting';
    if (becameBooting) m.status = 'host_booting';
    this.touch(m);
    this.emitMatch(m, 'match.boot_progress', {
      bootPhase: m.bootPhase,
      bootMessage: m.bootMessage,
    });
    this.emitMatch(m, 'match.updated');
    if (becameBooting) void this.announcePrivateMatchChat(m, hostUserId);
    return this.payload(m);
  }

  setTeam(userId: number, matchId: string, team: 'CT' | 'T') {
    const m = this.get(matchId);
    const p = this.requirePlayer(m, userId);
    p.team = team;
    this.touch(m);
    this.emitMatch(m, 'match.updated');
    return this.payload(m);
  }

  /** Host move um jogador de time (lobby / live). */
  async hostSetTeam(hostUserId: number, matchId: string, targetUserId: number, team: 'CT' | 'T' | 'SPEC') {
    const m = this.get(matchId);
    if (m.hostUserId !== hostUserId) {
      throw new ForbiddenException({ ok: false, error: 'host_only' });
    }
    const p = this.requirePlayer(m, targetUserId);
    p.team = team;
    await this.enrichSteamIds(m);
    this.touch(m);
    this.emitMatch(m, 'match.updated');
    if (m.status === 'host_booting' || m.status === 'connecting' || m.status === 'live') {
      void this.ensureVoiceChannels(m);
    }
    return this.payload(m, hostUserId);
  }

  setAdminSettings(
    hostUserId: number,
    matchId: string,
    settings: NonNullable<PrivateMatch['adminSettings']>,
  ) {
    const m = this.get(matchId);
    if (m.hostUserId !== hostUserId) {
      throw new ForbiddenException({ ok: false, error: 'host_only' });
    }
    m.adminSettings = {
      ...(m.adminSettings || {}),
      ...settings,
    };
    this.touch(m);
    this.emitMatch(m, 'match.updated');
    return this.payload(m, hostUserId);
  }

  async startVote(hostUserId: number, matchId: string, _durationSec = 30) {
    const m = this.get(matchId);
    if (m.hostUserId !== hostUserId) {
      throw new ForbiddenException({ ok: false, error: 'host_only' });
    }
    const pool = [...(m.mapPool.length ? m.mapPool : MAP_POOL)];
    const active = this.activePlayers(m);
    shuffleInPlace(active);
    const half = Math.ceil(active.length / 2);
    active.forEach((p, i) => {
      p.team = i < half ? 'CT' : 'T';
    });
    const firstTeam: 'CT' | 'T' = Math.random() < 0.5 ? 'CT' : 'T';
    const slices = banSlices(pool.length, firstTeam);
    const first = slices[0];
    // Radar real por winrate do time sorteado (0 = centro)
    const ctPlayers = active.filter((p) => p.team === 'CT');
    const tPlayers = active.filter((p) => p.team === 'T');
    const ctStats = await Promise.all(ctPlayers.map((p) => this.loadMapStats(p.userId)));
    const tStats = await Promise.all(tPlayers.map((p) => this.loadMapStats(p.userId)));
    m.radarByTeam = {
      CT: radarFromWinrates(pool, ctStats),
      T: radarFromWinrates(pool, tStats),
    };
    m.status = 'voting';
    m.votes = {};
    for (const p of active) {
      if (typeof p.rating !== 'number') p.rating = await this.loadRating(p.userId);
      m.votes[String(p.userId)] = pool[Math.abs(p.userId) % pool.length];
    }
    m.votedMap = '';
    m.veto = {
      slices,
      sliceIndex: 0,
      remainingInSlice: first?.kind === 'ban' ? first.count : 0,
      turnTeam: first?.team || firstTeam,
      mapsLeft: [...pool],
      bans: [],
      turnEndsAt: Date.now() + TURN_MS,
      startingSide: '',
      pickerUserId: 0,
      simulated: active.some((p) => p.userId < 0 || p.simulated),
    };
    m.voteEndsAt = m.veto.turnEndsAt;
    this.touch(m);
    this.emitMatch(m, 'match.vote_started');
    this.emitMatch(m, 'match.updated');
    this.armVetoTimer(m);
    this.maybeSimTurn(m);
    return this.payload(m, hostUserId);
  }

  private currentSlice(m: PrivateMatch) {
    return m.veto?.slices[m.veto.sliceIndex];
  }

  private armVetoTimer(m: PrivateMatch) {
    this.clearTimer(m.id);
    if (!m.veto || m.status !== 'voting') return;
    const ends = m.veto.turnEndsAt;
    const id = m.id;
    const t = setTimeout(() => {
      try {
        const cur = this.matches.get(id);
        if (!cur?.veto || cur.status !== 'voting' || cur.veto.turnEndsAt !== ends) return;
        this.autoVetoAct(cur);
      } catch {
        /* ignore */
      }
    }, Math.max(200, ends - Date.now() + 30));
    this.timers.set(id, t);
  }

  private teamHasHuman(m: PrivateMatch, team: 'CT' | 'T') {
    return m.players.some(
      (p) =>
        p.team === team &&
        p.userId > 0 &&
        !p.simulated &&
        (p.inviteStatus === 'host' || p.inviteStatus === 'accepted'),
    );
  }

  private maybeSimTurn(m: PrivateMatch) {
    if (!m.veto || m.status !== 'voting') return;
    const slice = this.currentSlice(m);
    if (!slice || slice.kind === 'done') return;
    if (slice.kind === 'pick_side') {
      const picker = m.players.find((p) => p.userId === m.veto!.pickerUserId);
      if (picker && picker.userId > 0 && !picker.simulated) return;
    } else if (this.teamHasHuman(m, m.veto.turnTeam)) {
      return;
    }
    this.clearTimer(m.id);
    const id = m.id;
    const t = setTimeout(() => {
      try {
        const cur = this.matches.get(id);
        if (!cur || cur.id !== m.id) return;
        this.autoVetoAct(cur);
      } catch {
        /* ignore */
      }
    }, SIM_TURN_MS);
    this.timers.set(id, t);
  }

  private autoVetoAct(m: PrivateMatch) {
    if (!m.veto || m.status !== 'voting') return;
    const slice = this.currentSlice(m);
    if (!slice) return;
    if (slice.kind === 'pick_side') {
      this.applyPickSide(m, Math.random() < 0.5 ? 'CT' : 'T');
      return;
    }
    if (slice.kind === 'ban') {
      const left = m.veto.mapsLeft.filter((x) => !m.veto!.bans.some((b) => b.map === x));
      const pick = left[Math.floor(Math.random() * left.length)];
      if (pick) this.applyBan(m, pick, m.veto.turnTeam);
    }
  }

  private applyBan(m: PrivateMatch, mapId: string, team: 'CT' | 'T') {
    if (!m.veto) return;
    const slice = this.currentSlice(m);
    if (!slice || slice.kind !== 'ban') {
      throw new BadRequestException({ ok: false, error: 'not_ban_phase' });
    }
    if (m.veto.turnTeam !== team) {
      throw new BadRequestException({ ok: false, error: 'not_your_turn' });
    }
    if (!m.veto.mapsLeft.includes(mapId) || m.veto.bans.some((b) => b.map === mapId)) {
      throw new BadRequestException({ ok: false, error: 'bad_map' });
    }
    m.veto.bans.push({ map: mapId, team });
    m.veto.mapsLeft = m.veto.mapsLeft.filter((x) => x !== mapId);
    m.veto.remainingInSlice -= 1;
    if (m.veto.mapsLeft.length <= 1) {
      m.votedMap = m.veto.mapsLeft[0] || mapId;
      this.advanceToPickSide(m);
    } else if (m.veto.remainingInSlice <= 0) {
      m.veto.sliceIndex += 1;
      const next = this.currentSlice(m);
      if (!next || next.kind === 'pick_side') {
        m.votedMap = m.veto.mapsLeft[0] || '';
        this.advanceToPickSide(m);
      } else if (next.kind === 'ban') {
        m.veto.turnTeam = next.team;
        m.veto.remainingInSlice = next.count;
        m.veto.turnEndsAt = Date.now() + TURN_MS;
        m.voteEndsAt = m.veto.turnEndsAt;
      }
    } else {
      m.veto.turnEndsAt = Date.now() + TURN_MS;
      m.voteEndsAt = m.veto.turnEndsAt;
    }
    this.touch(m);
    this.emitMatch(m, 'match.vote_cast');
    this.emitMatch(m, 'match.updated');
    this.armVetoTimer(m);
    this.maybeSimTurn(m);
  }

  private advanceToPickSide(m: PrivateMatch) {
    if (!m.veto) return;
    const pickIdx = m.veto.slices.findIndex((s) => s.kind === 'pick_side');
    m.veto.sliceIndex = pickIdx >= 0 ? pickIdx : m.veto.slices.length - 2;
    const chosen = chooseSidePicker(m.players);
    m.veto.turnTeam = chosen?.team || m.veto.turnTeam;
    m.veto.pickerUserId = chosen?.userId || 0;
    const slice = this.currentSlice(m);
    if (slice) slice.team = m.veto.turnTeam;
    m.veto.remainingInSlice = 1;
    m.veto.turnEndsAt = Date.now() + TURN_MS;
    m.voteEndsAt = m.veto.turnEndsAt;
  }

  private applyPickSide(m: PrivateMatch, side: 'CT' | 'T') {
    if (!m.veto) return;
    const slice = this.currentSlice(m);
    if (slice && slice.kind !== 'pick_side') {
      throw new BadRequestException({ ok: false, error: 'not_side_phase' });
    }
    const picker =
      m.players.find((p) => p.userId === m.veto!.pickerUserId) ||
      m.players.find((p) => p.team === m.veto!.turnTeam);
    const pickerTeam =
      picker?.team === 'CT' || picker?.team === 'T' ? picker.team : m.veto.turnTeam;
    applyStartingSideSwap(m.players, pickerTeam, side);
    m.veto.startingSide = side;
    m.veto.sliceIndex = m.veto.slices.findIndex((s) => s.kind === 'done');
    if (m.veto.sliceIndex < 0) m.veto.sliceIndex = m.veto.slices.length - 1;
    m.votedMap = m.veto.mapsLeft[0] || m.votedMap || m.mapPool[0];
    this.clearTimer(m.id);
    this.touch(m);
    void this.endVote(m.hostUserId, m.id);
  }

  vetoBan(userId: number, matchId: string, mapId: string) {
    const m = this.get(matchId);
    const p = this.requirePlayer(m, userId);
    if (m.status !== 'voting' || !m.veto) {
      throw new BadRequestException({ ok: false, error: 'not_voting' });
    }
    if (m.veto.bans.some((b) => b.map === mapId)) {
      throw new BadRequestException({ ok: false, error: 'banned' });
    }
    m.votes[String(userId)] = mapId;
    const slice = this.currentSlice(m);
    if (slice?.kind === 'ban' && p.team && p.team === m.veto.turnTeam) {
      this.applyBan(m, mapId, p.team);
      return this.payload(m, userId);
    }
    this.touch(m);
    this.emitMatch(m, 'match.vote_cast');
    this.emitMatch(m, 'match.updated');
    return this.payload(m, userId);
  }

  vetoSide(userId: number, matchId: string, side: 'CT' | 'T') {
    const m = this.get(matchId);
    const p = this.requirePlayer(m, userId);
    if (m.status !== 'voting' || !m.veto) {
      throw new BadRequestException({ ok: false, error: 'not_voting' });
    }
    if (m.veto.pickerUserId) {
      if (userId !== m.veto.pickerUserId) {
        throw new ForbiddenException({ ok: false, error: 'not_your_turn' });
      }
    } else if (!p.team || p.team !== m.veto.turnTeam) {
      throw new ForbiddenException({ ok: false, error: 'not_your_turn' });
    }
    this.applyPickSide(m, side);
    return this.payload(m, userId);
  }

  castVote(userId: number, matchId: string, mapId: string) {
    return this.vetoBan(userId, matchId, mapId);
  }

  async endVote(hostUserId: number, matchId: string) {
    const m = this.get(matchId);
    if (m.hostUserId !== hostUserId) {
      throw new ForbiddenException({ ok: false, error: 'host_only' });
    }
    if (m.status !== 'voting' && m.status !== 'host_booting') {
      throw new BadRequestException({ ok: false, error: 'not_voting' });
    }
    await this.enrichSteamIds(m);
    let best = m.votedMap || m.veto?.mapsLeft?.[0] || m.mapPool[0];
    if (!m.votedMap) {
      const counts = new Map<string, number>();
      for (const mapId of Object.values(m.votes)) {
        counts.set(mapId, (counts.get(mapId) || 0) + 1);
      }
      let bestN = -1;
      for (const mapId of m.mapPool) {
        const n = counts.get(mapId) || 0;
        if (n > bestN) {
          best = mapId;
          bestN = n;
        }
      }
    }
    m.votedMap = best;
    m.voteEndsAt = 0;
    m.readyCountdownEndsAt = 0;
    // Bots só preenchem o lobby/veto — humanos no Desktop ainda sobem dedicated + steam://.
    if (m.mode === 'valve') {
      this.touch(m);
      this.emitMatch(m, 'match.vote_ended', { votedMap: best });
      return this.startValve(hostUserId, matchId);
    }
    m.status = 'host_booting';
    m.bootPhase = 'starting_dedicated';
    m.bootMessage = 'A subir dedicated / preparar server…';
    this.touch(m);
    this.emitMatch(m, 'match.vote_ended', { votedMap: best });
    this.emitMatch(m, 'match.boot_progress', {
      bootPhase: m.bootPhase,
      bootMessage: m.bootMessage,
    });
    this.emitMatch(m, 'match.updated');
    void this.ensureVoiceChannels(m);
    void this.announcePrivateMatchChat(m, hostUserId);
    return this.payload(m);
  }

  /** Host publica endpoint após listen-server (ou mock local). */
  async hostReady(
    hostUserId: number,
    matchId: string,
    opts: { host?: string; port?: number; password?: string },
  ) {
    const m = this.get(matchId);
    if (m.hostUserId !== hostUserId) {
      throw new ForbiddenException({ ok: false, error: 'host_only' });
    }
    if (m.mode !== 'host_listen') {
      throw new BadRequestException({ ok: false, error: 'dedicated_only' });
    }
    await this.enrichSteamIds(m);
    const host = String(opts.host || '127.0.0.1').trim();
    const port = Number(opts.port) > 0 ? Number(opts.port) : 27015;
    const password = String(opts.password || m.roomPassword).trim();
    const map = m.votedMap || 'mirage';
    m.connect = {
      host,
      port,
      password,
      map,
      connectString: `password ${password}; connect ${host}:${port}`,
    };
    m.status = 'connecting';
    m.bootPhase = 'publishing_connect';
    m.bootMessage = 'Server ready — a publicar connect…';
    this.touch(m);
    this.emitMatch(m, 'match.connect', { connect: m.connect });
    this.emitMatch(m, 'match.boot_progress', {
      bootPhase: m.bootPhase,
      bootMessage: m.bootMessage,
    });
    this.emitMatch(m, 'match.updated');
    void this.ensureVoiceChannels(m);
    void this.announcePrivateMatchChat(m, hostUserId);
    return this.payload(m);
  }

  /** Mensagem de sistema no chat do servidor (uma vez por partida). */
  private async announcePrivateMatchChat(m: PrivateMatch, actorUserId: number) {
    if (m.systemChatPosted) return;
    m.systemChatPosted = true;
    const notice = String(m.welcomeMessage || '').trim() || 'Partida Privada Castino.Tech';
    m.feed.push({
      t: 'system',
      type: 'system',
      text: notice,
      at: Date.now(),
    });
    this.emitMatch(m, 'match.updated');
    try {
      const res = await this.community.postSystemToServer(m.serverId, actorUserId, notice);
      if (!res?.ok) {
        m.systemChatPosted = false;
        console.warn('[private-match] system chat failed', {
          serverId: m.serverId,
          matchId: m.id,
          error: res?.error || res,
        });
        return;
      }
      console.log('[private-match] system chat ok', {
        serverId: m.serverId,
        matchId: m.id,
        channelId: res.message?.channel_id,
        messageId: res.message?.id,
      });
    } catch (e) {
      m.systemChatPosted = false;
      console.warn('[private-match] system chat error', e instanceof Error ? e.message : e);
    }
  }

  /** Modo Valve: host dispara “abrir CS2 / pool”. */
  startValve(hostUserId: number, matchId: string) {
    const m = this.get(matchId);
    if (m.hostUserId !== hostUserId) {
      throw new ForbiddenException({ ok: false, error: 'host_only' });
    }
    if (m.mode !== 'valve') {
      throw new BadRequestException({ ok: false, error: 'valve_only' });
    }
    m.status = 'connecting';
    m.connect = {
      host: '',
      port: 0,
      password: '',
      map: '',
      connectString: `VALVE-POOL-${m.id.slice(0, 8).toUpperCase()}`,
    };
    this.touch(m);
    this.emitMatch(m, 'match.valve_start', { poolCode: m.connect.connectString });
    this.emitMatch(m, 'match.updated');
    void this.ensureVoiceChannels(m);
    return this.payload(m);
  }

  markConnected(userId: number, matchId: string, connected: boolean) {
    const m = this.get(matchId);
    const p = this.requirePlayer(m, userId);
    p.connected = !!connected;
    p.inServer = !!connected;
    if (!connected) {
      p.alive = null;
      p.health = null;
    }
    if (connected && m.status === 'connecting') {
      const accepted = m.players.filter(
        (x) => x.inviteStatus === 'accepted' || x.inviteStatus === 'host',
      );
      if (accepted.every((x) => x.connected)) m.status = 'live';
      else if (accepted.filter((x) => x.connected).length >= 1) m.status = 'live';
    }
    this.touch(m);
    this.emitMatch(m, 'match.updated');
    if (connected) void this.publishMatchCs2Live(m);
    return this.payload(m);
  }

  /**
   * Host reporta presença de todos; convidado pode reportar só a própria linha (GSI self).
   * rows: steamid/name → inServer / alive / health / gameTeam
   */
  syncPresence(
    userId: number,
    matchId: string,
    rows: Array<{
      steamid?: string;
      name?: string;
      userId?: number;
      inServer?: boolean;
      alive?: boolean | null;
      health?: number | null;
      gameTeam?: 'CT' | 'T' | 'SPEC' | '';
    }>,
  ) {
    const m = this.get(matchId);
    const isHost = m.hostUserId === userId;
    if (!isHost && !this.player(m, userId)) {
      throw new ForbiddenException({ ok: false, error: 'forbidden' });
    }
    const raw = Array.isArray(rows) ? rows : [];
    // Convidado só atualiza a própria presença (força userId)
    const list = isHost
      ? raw
      : raw.slice(0, 1).map((r) => ({ ...r, userId }));
    const bySteam = new Map<string, (typeof list)[0]>();
    const byName = new Map<string, (typeof list)[0]>();
    const byUser = new Map<number, (typeof list)[0]>();
    for (const r of list) {
      const sid = String(r.steamid || '').replace(/\D/g, '');
      if (sid) bySteam.set(sid, r);
      const nm = String(r.name || '').trim().toLowerCase();
      if (nm) byName.set(nm, r);
      if (Number(r.userId) > 0) byUser.set(Number(r.userId), r);
    }

    let changed = false;
    for (const p of m.players) {
      if (p.userId < 0 || p.simulated) continue;
      const sid = String(p.steamid || '').replace(/\D/g, '');
      const hit =
        (Number.isFinite(p.userId) ? byUser.get(p.userId) : undefined) ||
        (sid ? bySteam.get(sid) : undefined) ||
        byName.get((p.displayName || p.username || '').trim().toLowerCase());

      // Sticky: só marca fora do server com hit explícito (Dropped).
      // Lista com bots/outros sem match NÃO deve derrubar o jogador (comum após warmup).
      let inServer = !!p.inServer;
      if (hit) {
        inServer = hit.inServer !== false;
      } else if (list.length === 0) {
        inServer = !!p.inServer;
      }
      // Se já estava no server e não há evidência de drop, mantém
      if (p.inServer && !hit) inServer = true;

      const nextAlive =
        hit && typeof hit.alive === 'boolean'
          ? hit.alive
          : hit && typeof hit.health === 'number'
            ? hit.health > 0
            : inServer
              ? p.alive
              : null;
      const nextHealth =
        hit && typeof hit.health === 'number' ? hit.health : inServer ? p.health : null;
      const hitTeam = hit?.gameTeam as MatchPlayer['gameTeam'] | undefined;
      const hitTeamOk = hitTeam === 'CT' || hitTeam === 'T' || hitTeam === 'SPEC';
      // Em live: não cair no lobby p.team (sticky pós-half). Preferir GSI / último gameTeam.
      let nextGameTeam: MatchPlayer['gameTeam'] = '';
      if (hitTeamOk && hitTeam) {
        nextGameTeam = hitTeam;
      } else if (p.gameTeam === 'CT' || p.gameTeam === 'T' || p.gameTeam === 'SPEC') {
        nextGameTeam = p.gameTeam;
      } else if (m.status !== 'live' && m.status !== 'connecting') {
        nextGameTeam =
          p.team === 'CT' || p.team === 'T' || p.team === 'SPEC' ? p.team : '';
      }

      if (
        p.inServer !== inServer ||
        p.alive !== nextAlive ||
        p.health !== nextHealth ||
        (p.gameTeam || '') !== (nextGameTeam || '')
      ) {
        p.inServer = inServer;
        if (inServer) p.connected = true;
        p.alive = nextAlive ?? null;
        p.health = nextHealth ?? null;
        p.gameTeam = nextGameTeam || '';
        changed = true;
      }
    }

    // Sempre republica cards (TTL Redis 45s) — não depende de “changed”
    void this.publishMatchCs2Live(m);

    if (changed) {
      this.touch(m);
      this.emitMatch(m, 'match.updated');
    }
    return this.payload(m, userId);
  }

  ingestStats(
    userId: number,
    matchId: string,
    body: {
      scoreCt?: number;
      scoreT?: number;
      round?: number;
      phase?: string;
      stats?: MatchStatsRow[];
      /** Se true, faz merge por steamid/nome em vez de substituir o array. */
      merge?: boolean;
      feedItem?: { t: string; type: string; text: string };
    },
  ) {
    const m = this.get(matchId);
    this.requirePlayer(m, userId);
    if (typeof body.scoreCt === 'number') m.scoreCt = body.scoreCt;
    if (typeof body.scoreT === 'number') m.scoreT = body.scoreT;
    if (typeof body.round === 'number') m.round = body.round;
    if (Array.isArray(body.stats) && body.stats.length) {
      const incoming = body.stats.map((s) => ({ ...s, at: Date.now() }));
      if (body.merge) {
        const next = [...(m.stats || [])];
        const nameLooseEq = (a: string, b: string) => {
          if (!a || !b) return false;
          if (a === b) return true;
          if (a.startsWith(`${b} `) || b.startsWith(`${a} `)) return true;
          const af = a.split(/\s+/)[0] || '';
          const bf = b.split(/\s+/)[0] || '';
          return af.length >= 3 && af === bf;
        };
        for (const row of incoming) {
          const sid = String(row.steamid || '').replace(/\D/g, '');
          const nm = String(row.name || '').trim().toLowerCase();
          const idx = next.findIndex((x) => {
            const xs = String(x.steamid || '').replace(/\D/g, '');
            if (sid && xs && sid === xs) return true;
            if (row.userId > 0 && x.userId === row.userId) return true;
            const xn = String(x.name || '').trim().toLowerCase();
            if (nameLooseEq(nm, xn)) return true;
            return false;
          });
          // Liga userId do roster da partida
          if (!row.userId) {
            const p = m.players.find((pl) => {
              const ps = String(pl.steamid || '').replace(/\D/g, '');
              if (sid && ps && sid === ps) return true;
              const pn = (pl.displayName || pl.username || '').trim().toLowerCase();
              return nameLooseEq(nm, pn);
            });
            if (p) row.userId = p.userId;
          }
          if (idx >= 0) {
            const prev = next[idx];
            // Sticky métricas: merge nunca reduz K/A/D (sair da sala não zera)
            next[idx] = {
              ...prev,
              ...row,
              kills: Math.max(Number(prev.kills) || 0, Number(row.kills) || 0),
              assists: Math.max(Number(prev.assists) || 0, Number(row.assists) || 0),
              deaths: Math.max(Number(prev.deaths) || 0, Number(row.deaths) || 0),
              at: Date.now(),
            };
          } else next.push(row);
        }
        m.stats = next;
      } else {
        m.stats = incoming;
      }
    }
    if (body.feedItem?.text) {
      m.feed.unshift({
        t: body.feedItem.t || '',
        type: body.feedItem.type || 'kill',
        text: body.feedItem.text,
        at: Date.now(),
      });
      m.feed = m.feed.slice(0, 80);
    }
    // Actualiza gameTeam a partir do GSI (stats.team) — lado actual pós-half
    for (const s of m.stats || []) {
      const side = String(s.team || '').toUpperCase();
      if (side !== 'CT' && side !== 'T' && side !== 'SPEC') continue;
      const sid = String(s.steamid || '').replace(/\D/g, '');
      const nm = String(s.name || '').trim().toLowerCase();
      const p = m.players.find((pl) => {
        if (s.userId > 0 && pl.userId === s.userId) return true;
        const ps = String(pl.steamid || '').replace(/\D/g, '');
        if (sid && ps && sid === ps) return true;
        const pn = (pl.displayName || pl.username || '').trim().toLowerCase();
        return !!(nm && pn && nm === pn);
      });
      if (p) p.gameTeam = side as MatchPlayer['gameTeam'];
    }
    if (m.status === 'connecting') m.status = 'live';
    this.touch(m);
    this.emitMatch(m, 'match.stats', {
      scoreCt: m.scoreCt,
      scoreT: m.scoreT,
      round: m.round,
      stats: m.stats,
      feed: m.feed.slice(0, 20),
    });
    // Espelha stats/presença nos cards de membros
    void this.publishMatchCs2Live(m);
    const phase = String(body.phase || '').toLowerCase();
    if (phase === 'gameover' && m.hostUserId === userId && m.status === 'live') {
      return this.end(userId, matchId);
    }
    return this.payload(m);
  }

  /** Publica cs2_live (Redis) a partir da partida — cards de membros sem GSI próprio. */
  private async publishMatchCs2Live(m: PrivateMatch) {
    if (m.status !== 'live' && m.status !== 'connecting') return;
    const mapName = String(m.votedMap || m.connect?.map || 'CS2').replace(/^de_/, '');
    for (const p of m.players) {
      if (p.userId < 0 || p.simulated) continue;
      if (p.inviteStatus !== 'host' && p.inviteStatus !== 'accepted') continue;
      if (p.team === 'SPEC') continue;
      const st = (m.stats || []).find((s) => {
        const sid = String(s.steamid || '').replace(/\D/g, '');
        const ps = String(p.steamid || '').replace(/\D/g, '');
        if (sid && ps && sid === ps) return true;
        if (s.userId > 0 && s.userId === p.userId) return true;
        return false;
      });
      const team = String(p.gameTeam || p.team || '').toUpperCase();
      const health =
        typeof p.health === 'number'
          ? p.health
          : p.alive === false
            ? 0
            : p.alive === true
              ? 100
              : 100;
      const kills = Number(st?.kills) || 0;
      const deaths = Number(st?.deaths) || 0;
      try {
        // Não sobrescrever GSI fresco do cliente com zeros da partida
        const prev = await this.presence.getCs2Live(p.userId).catch(() => null);
        const prevFresh =
          prev &&
          typeof prev.at === 'number' &&
          Date.now() - prev.at < 20000 &&
          prev.kind === 'match';
        const keepNums =
          prevFresh &&
          kills === 0 &&
          deaths === 0 &&
          ((Number(prev.kills) || 0) > 0 || (Number(prev.deaths) || 0) > 0);
        await this.presence.setCs2Live(p.userId, {
          at: Date.now(),
          map: mapName || String(prev?.map || 'CS2'),
          scoreCt: typeof m.scoreCt === 'number' ? m.scoreCt : Number(prev?.scoreCt) || 0,
          scoreT: typeof m.scoreT === 'number' ? m.scoreT : Number(prev?.scoreT) || 0,
          team: team === 'CT' || team === 'T' ? team : String(prev?.team || ''),
          kills: keepNums ? Number(prev.kills) || 0 : kills,
          deaths: keepNums ? Number(prev.deaths) || 0 : deaths,
          health: keepNums && typeof prev.health === 'number' ? prev.health : health,
          kind: 'match',
          mode: m.mode === 'host_listen' ? 'dedicated' : 'private',
          modeLabel: 'Partida privada',
          phase: m.status,
        });
      } catch {
        /* ignore */
      }
    }
  }

  async openTunnel(hostUserId: number, matchId: string) {
    const m = this.get(matchId);
    if (m.hostUserId !== hostUserId) {
      throw new ForbiddenException({ ok: false, error: 'host_only' });
    }
    if (m.mode !== 'host_listen') {
      throw new BadRequestException({ ok: false, error: 'dedicated_only' });
    }
    try {
      const slot = await this.tunnel.allocate(matchId);
      return { ok: true, ...slot };
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      throw new BadRequestException({ ok: false, error: err || 'tunnel_failed' });
    }
  }

  async end(userId: number, matchId: string) {
    const m = this.get(matchId);
    if (m.hostUserId !== userId) {
      throw new ForbiddenException({ ok: false, error: 'host_only' });
    }
    if (m.status === 'ended') return this.payload(m);
    m.status = 'ended';
    this.tunnel.release(matchId);
    this.touch(m);
    await this.teardownVoiceChannels(m);
    void this.persistResult(m);
    this.emitMatch(m, 'match.ended');
    this.emitMatch(m, 'match.updated');
    return this.payload(m);
  }

  async ranking(serverId: number) {
    const rows = await this.prisma.communityMember.findMany({
      where: { serverId },
      include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
    });
    const list: Array<{
      userId: number;
      username: string;
      displayName: string;
      avatarUrl: string;
      rating: number;
    }> = [];
    for (const r of rows) {
      list.push({
        userId: r.user.id,
        username: r.user.username,
        displayName: r.user.displayName || r.user.username,
        avatarUrl: r.user.avatarUrl,
        rating: await this.loadRating(r.user.id),
      });
    }
    list.sort((a, b) => b.rating - a.rating);
    return { ok: true, ranking: list };
  }

  async history(serverId: number) {
    return {
      ok: true,
      matches: this.records.filter((r) => r.serverId === serverId).slice(0, 40),
    };
  }

  private async persistResult(m: PrivateMatch) {
    const humans = m.players.filter(
      (p) =>
        p.userId > 0 &&
        !p.simulated &&
        p.team !== 'SPEC' &&
        (p.inviteStatus === 'host' || p.inviteStatus === 'accepted'),
    );
    const rated: Array<{
      userId: number;
      team: string;
      name: string;
      ratingBefore: number;
      ratingAfter: number;
      delta: number;
    }> = [];
    const play = !m.veto?.simulated && humans.length >= 2 && (m.scoreCt > 0 || m.scoreT > 0);
    const ctWin = m.scoreCt > m.scoreT;
    const draw = m.scoreCt === m.scoreT;
    const mapKey = String(m.votedMap || m.connect?.map || '')
      .replace(/^de_/, '')
      .toLowerCase();

    for (const p of humans) {
      const before = await this.loadRating(p.userId);
      let after = before;
      let delta = 0;
      const side =
        p.gameTeam === 'CT' || p.gameTeam === 'T'
          ? p.gameTeam
          : p.team === 'CT' || p.team === 'T'
            ? p.team
            : '';
      if (play && (side === 'CT' || side === 'T')) {
        const won = !draw && (side === 'CT' ? ctWin : !ctWin);
        delta = this.scoreDeltaForPlayer(p, m, won, draw);
        after = Math.max(0, Math.min(100000, before + delta));
        await this.saveRating(p.userId, after);
        if (!draw && mapKey) await this.bumpMapStat(p.userId, mapKey, won);
      }
      p.rating = after;
      rated.push({
        userId: p.userId,
        team: side || p.team,
        name: p.displayName,
        ratingBefore: before,
        ratingAfter: after,
        delta,
      });
    }
    this.records.unshift({
      id: m.id,
      serverId: m.serverId,
      name: m.name,
      map: m.votedMap || m.connect?.map || '',
      format: m.format,
      scoreCt: m.scoreCt,
      scoreT: m.scoreT,
      endedAt: Date.now(),
      players: rated,
    });
    this.records = this.records.slice(0, 80);
  }

  private voiceAllow(m: PrivateMatch, team: 'CT' | 'T' | 'SPEC') {
    return new Set(
      m.players
        .filter(
          (p) =>
            p.userId > 0 &&
            !p.simulated &&
            (p.inviteStatus === 'host' || p.inviteStatus === 'accepted') &&
            (team === 'SPEC' ? p.team === 'SPEC' : p.team === team),
        )
        .map((p) => p.userId),
    );
  }

  private refreshVoiceAcl(m: PrivateMatch) {
    const ch = m.voiceChannels || {};
    if (ch.CT) setMatchVoiceAcl(ch.CT, { matchId: m.id, team: 'CT', allow: this.voiceAllow(m, 'CT') });
    if (ch.T) setMatchVoiceAcl(ch.T, { matchId: m.id, team: 'T', allow: this.voiceAllow(m, 'T') });
    if (ch.SPEC) setMatchVoiceAcl(ch.SPEC, { matchId: m.id, team: 'SPEC', allow: this.voiceAllow(m, 'SPEC') });
  }

  private async ensureVoiceChannels(m: PrivateMatch) {
    try {
      const needSpec = m.players.some((p) => p.team === 'SPEC');
      const max = await this.prisma.communityChannel.aggregate({
        where: { serverId: m.serverId },
        _max: { position: true },
      });
      let pos = (max._max.position ?? 0) + 1;
      const make = async (team: 'CT' | 'T' | 'SPEC', name: string) => {
        const existing = m.voiceChannels?.[team];
        if (existing) {
          const row = await this.prisma.communityChannel.findUnique({ where: { id: existing } });
          if (row) return existing;
        }
        const channel = await this.prisma.communityChannel.create({
          data: {
            serverId: m.serverId,
            name,
            kind: 'voice',
            position: pos++,
            createdAt: Date.now() / 1000,
          },
        });
        return channel.id;
      };
      const CT = await make('CT', '👮‍♂️ CT');
      const T = await make('T', '🥷 TR');
      const SPEC = needSpec ? await make('SPEC', '👁 Assistir') : m.voiceChannels?.SPEC;
      m.voiceChannels = { CT, T, ...(SPEC ? { SPEC } : {}) };
      this.refreshVoiceAcl(m);
      this.touch(m);
      this.realtime.emitToServer(m.serverId, 'server.channels', {
        matchId: m.id,
        voiceChannels: m.voiceChannels,
      });
      this.emitMatch(m, 'match.updated');
      // Dá tempo ao cliente de invalidar a lista de canais antes do force-join.
      await new Promise((r) => setTimeout(r, 350));
      await this.forceJoinTeamVoices(m);
    } catch (err) {
      console.warn('[private-match] voice channels', err);
    }
  }

  private async forceJoinTeamVoices(m: PrivateMatch) {
    const ch = m.voiceChannels || {};
    const matchChannelIds = new Set(
      [ch.CT, ch.T, ch.SPEC].filter((n): n is number => typeof n === 'number' && n > 0),
    );
    for (const p of m.players) {
      if (p.userId < 0 || p.simulated) continue;
      if (p.inviteStatus !== 'host' && p.inviteStatus !== 'accepted') continue;
      const channelId =
        p.team === 'T' ? ch.T : p.team === 'SPEC' ? ch.SPEC : p.team === 'CT' ? ch.CT : 0;
      if (!channelId) continue;
      try {
        const prev = await this.presence.getActiveVoice(p.userId);
        if (
          prev?.channelId &&
          prev.channelId !== channelId &&
          !matchChannelIds.has(prev.channelId) &&
          !p.previousVoiceChannelId
        ) {
          p.previousVoiceChannelId = prev.channelId;
        }
      } catch {
        /* ignore */
      }
      const name = p.team === 'T' ? '🥷 TR' : p.team === 'SPEC' ? '👁 Assistir' : '👮‍♂️ CT';
      const payload = {
        server_id: m.serverId,
        channel_id: channelId,
        channel_name: name,
        match_id: m.id,
        user_id: p.userId,
      };
      this.realtime.emitToUser(p.userId, 'voice.force_join', payload);
      this.realtime.emitToServer(m.serverId, 'voice.force_join', payload);
    }
  }

  private async resolveFallbackVoiceChannel(
    serverId: number,
    excludeIds: Set<number>,
  ): Promise<number> {
    const exclude = [...excludeIds];
    const row = await this.prisma.communityChannel.findFirst({
      where: {
        serverId,
        kind: { in: ['voice', 'screen'] },
        ...(exclude.length ? { id: { notIn: exclude } } : {}),
      },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    return row?.id || 0;
  }

  private async teardownVoiceChannels(m: PrivateMatch) {
    const ids = [m.voiceChannels?.CT, m.voiceChannels?.T, m.voiceChannels?.SPEC].filter(
      (n): n is number => !!n,
    );
    const matchChannelIds = new Set(ids);
    const fallbackId = await this.resolveFallbackVoiceChannel(m.serverId, matchChannelIds);

    for (const p of m.players) {
      if (p.userId < 0 || p.simulated) continue;
      let restoreId = p.previousVoiceChannelId || 0;
      if (restoreId && matchChannelIds.has(restoreId)) restoreId = 0;
      if (!restoreId) restoreId = fallbackId;
      const payload = {
        server_id: m.serverId,
        channel_id: restoreId,
        match_id: m.id,
        user_id: p.userId,
      };
      this.realtime.emitToUser(p.userId, 'voice.restore', payload);
      this.realtime.emitToServer(m.serverId, 'voice.restore', payload);
      p.previousVoiceChannelId = undefined;
    }

    // Clientes saem das salas temp antes de as apagar.
    await new Promise((r) => setTimeout(r, 900));

    for (const id of ids) {
      clearMatchVoiceAcl(id);
      try {
        await this.prisma.communityChannel.delete({ where: { id } });
      } catch {
        /* already gone */
      }
    }
    m.voiceChannels = {};
    this.realtime.emitToServer(m.serverId, 'server.channels', { matchId: m.id, voiceChannels: {} });
    // Refetch da lista de canais no cliente.
    this.realtime.emitToServer(m.serverId, 'server.updated', { serverId: m.serverId });
  }
}
