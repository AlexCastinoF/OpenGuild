import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { getSocket } from './socket';
import { pushNotify } from './commNotify';

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
  steamid?: string;
  team: 'CT' | 'T' | 'SPEC' | '';
  ready: boolean;
  connected: boolean;
  inServer?: boolean;
  alive?: boolean | null;
  health?: number | null;
  gameTeam?: 'CT' | 'T' | 'SPEC' | '';
  isHost: boolean;
  inviteStatus: 'host' | 'accepted' | 'pending' | 'declined';
  simulated?: boolean;
  rating?: number;
};

export type MatchVetoSlice = {
  kind: 'ban' | 'pick_side' | 'done';
  count: number;
  team: 'CT' | 'T';
  label: string;
};

export type MatchVeto = {
  slices: MatchVetoSlice[];
  sliceIndex: number;
  remainingInSlice: number;
  turnTeam: 'CT' | 'T';
  mapsLeft: string[];
  bans: Array<{ map: string; team: 'CT' | 'T' }>;
  turnEndsAt: number;
  startingSide: '' | 'CT' | 'T';
  pickerUserId?: number;
  simulated?: boolean;
};

export type MatchConnect = {
  host: string;
  port: number;
  password: string;
  connectString: string;
  map: string;
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
  votes: Record<string, string>;
  votedMap: string;
  voteEndsAt: number;
  veto?: MatchVeto | null;
  radar?: Record<string, number>;
  radarCt?: Record<string, number>;
  radarT?: Record<string, number>;
  teamRating?: { CT: number; T: number };
  voiceChannels?: { CT?: number; T?: number; SPEC?: number };
  canJoin?: boolean;
  canWatch?: boolean;
  isMember?: boolean;
  youPending?: boolean;
  serverNow?: number;
  readyCountdownEndsAt?: number;
  bootPhase?: string;
  bootMessage?: string;
  connect: MatchConnect | null;
  players: MatchPlayer[];
  scoreCt: number;
  scoreT: number;
  round: number;
  stats: Array<Record<string, unknown>>;
  feed: Array<{ t: string; type: string; text: string; at: number }>;
  updatedAt?: number;
  adminSettings?: Record<string, number | undefined>;
  matchPackVersion?: string;
  welcomeMessage?: string;
  welcomeColor?: string;
};

export type HostServerOpts = {
  hostname: string;
  cheats: boolean;
  port: number;
  /** Sons de kill do wizard (senão usa prefs Desktop). */
  soundSettings?: Record<string, unknown>;
};

export type BootInfo = {
  phase: string;
  message: string;
  step?: string;
  pid?: number;
  host?: string;
  port?: number;
  needsGslt?: boolean;
  gsltUrl?: string;
  readyConfirmed?: boolean;
};

type MatchPayload = { match?: PrivateMatch | null; connect?: MatchConnect; poolCode?: string };

function isDesktop() {
  return typeof window !== 'undefined' && !!window.sfDesktop;
}

export function usePrivateMatch(opts: {
  userId?: number;
  serverId?: number;
  enabled?: boolean;
}) {
  const { userId, serverId, enabled = true } = opts;
  const [incoming, setIncoming] = useState<PrivateMatch | null>(null);
  const [active, setActive] = useState<PrivateMatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [bootInfo, setBootInfo] = useState<BootInfo | null>(null);
  const [needsConsoleKey, setNeedsConsoleKey] = useState(false);
  const [hostOpts, setHostOpts] = useState<HostServerOpts>({
    hostname: '',
    cheats: false,
    port: 0,
  });
  const [serverRooms, setServerRooms] = useState<PrivateMatch[]>([]);
  const [connectPrompt, setConnectPrompt] = useState<PrivateMatch | null>(null);
  const connectingRef = useRef(false);
  const bootOnceRef = useRef<string>('');
  const connectOnceRef = useRef<string>('');
  const hostOptsRef = useRef(hostOpts);
  hostOptsRef.current = hostOpts;

  const syncTeamsToDedicated = useCallback((m: PrivateMatch) => {
    if (!isDesktop() || !window.sfDesktop?.matchRewriteTeams) return;
    if (m.hostUserId !== userId || m.mode !== 'host_listen') return;
    if (
      m.status !== 'host_booting' &&
      m.status !== 'connecting' &&
      m.status !== 'live'
    ) {
      return;
    }
    const roster = (m.players || [])
      .filter((p) => p.userId > 0 && !p.simulated)
      .map((p) => ({
        userId: p.userId,
        username: p.username,
        displayName: p.displayName,
        name: p.displayName || p.username,
        steamid: p.steamid || '',
        team: p.team,
      }));
    void window.sfDesktop.matchRewriteTeams(roster);
  }, [userId]);

  const applyMatch = useCallback((m?: PrivateMatch | null) => {
    if (!m) return;
    if (m.status === 'ended') {
      if (isDesktop() && m.hostUserId === userId) {
        void window.sfDesktop?.matchDedicatedStop?.().catch(() => undefined);
      }
      setActive((cur) => (cur?.id === m.id ? null : cur));
      setIncoming((cur) => (cur?.id === m.id ? null : cur));
      return;
    }
    const me = m.players.find((p) => p.userId === userId);
    if (me?.inviteStatus === 'pending') setIncoming(m);
    else if (me && me.inviteStatus !== 'declined') {
      setActive(m);
      setIncoming((cur) => (cur?.id === m.id ? null : cur));
      syncTeamsToDedicated(m);
    }
  }, [userId, syncTeamsToDedicated]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const data = await api<{ ok?: boolean; matches?: PrivateMatch[] }>('/api/private-match');
      const list = data.matches || [];
      const mine =
        list.find((m) => m.players.some((p) => p.userId === userId && p.inviteStatus !== 'pending')) ||
        null;
      const pend =
        list.find((m) => m.players.some((p) => p.userId === userId && p.inviteStatus === 'pending')) ||
        null;
      if (mine) setActive(mine);
      if (pend) setIncoming(pend);
    } catch {
      /* ignore */
    }
  }, [enabled, userId]);

  useEffect(() => {
    if (!enabled || !userId) return;
    void refresh();
  }, [enabled, userId, refresh]);

  useEffect(() => {
    if (!enabled || !isDesktop() || !window.sfDesktop?.matchConsoleKeyGet) return;
    void window.sfDesktop.matchConsoleKeyGet().then((r) => {
      if (r?.ok) setNeedsConsoleKey(!r.configured);
    });
  }, [enabled]);

  const ensureConsoleKey = useCallback(async () => {
    if (!isDesktop() || !window.sfDesktop?.matchConsoleKeyGet) return true;
    const r = await window.sfDesktop.matchConsoleKeyGet();
    if (r?.configured) {
      setNeedsConsoleKey(false);
      return true;
    }
    setNeedsConsoleKey(true);
    return false;
  }, []);

  const saveConsoleKey = useCallback(async (vk: number) => {
    if (!window.sfDesktop?.matchConsoleKeySet) return { ok: false };
    const r = await window.sfDesktop.matchConsoleKeySet(vk);
    if (r?.ok) setNeedsConsoleKey(false);
    return r || { ok: false };
  }, []);

  const tryAutoConnect = useCallback(async (m: PrivateMatch, force = false) => {
    if (!m.connect?.host) return { ok: false, error: 'no_connect' };
    if (!isDesktop() || !window.sfDesktop?.matchConnect) {
      return { ok: false, error: 'desktop_required' };
    }
    const key = `${m.id}:${m.connect.host}:${m.connect.port}`;
    if (!force && connectOnceRef.current === key) return { ok: false, error: 'already' };
    if (connectingRef.current && !force) return { ok: false, error: 'busy' };
    connectingRef.current = true;
    connectOnceRef.current = key;
    setBootInfo({
      phase: 'connecting',
      message: 'Dedicated confirmado — a ligar via Steam…',
      step: 'steam://connect (time atribuído pelo dedicated)',
      host: m.connect.host,
      port: m.connect.port,
      readyConfirmed: true,
    });
    try {
      const roster = (m.players || [])
        .filter((p) => p.userId > 0 && !p.simulated)
        .map((p) => ({
          userId: p.userId,
          username: p.username,
          displayName: p.displayName,
          name: p.displayName || p.username,
          steamid: p.steamid || '',
          team: p.team,
        }));
      const r = await window.sfDesktop.matchConnect({
        host: m.connect.host,
        port: m.connect.port,
        password: m.connect.password,
        map: m.connect.map,
        players: roster,
      });
      if (r?.error === 'needs_console_key') {
        setNeedsConsoleKey(true);
        setBootInfo({
          phase: 'needs_console_key',
          message: r.message || 'Define a tecla da consola.',
          step: 'Aguardando tecla da consola…',
        });
        return r;
      }
      if (r?.ok) {
        await api(`/api/private-match/${m.id}/connected`, {
          method: 'POST',
          body: JSON.stringify({ connected: true }),
        });
        setBootInfo({
          phase: 'connected',
          message: (r as { note?: string }).note || 'Connect enviado.',
          step: 'Connect enviado — verifica no CS2',
          host: m.connect.host,
          port: m.connect.port,
          readyConfirmed: true,
        });
        pushNotify({
          kind: 'community.match_connect',
          threadKey: `match:${m.id}:connect:${Date.now()}`,
          title: force ? 'Reconnect CS2' : 'Partida CS2',
          body:
            (r as { note?: string }).note ||
            (r.connectString ? `Copiado: ${r.connectString}` : 'A ligar ao server…'),
        });
      }
      return r || { ok: false };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      connectingRef.current = false;
    }
  }, [userId]);

  useEffect(() => {
    if (!enabled || !userId) return;
    const sock = getSocket();
    const onInvite = (payload: MatchPayload) => {
      if (payload.match) {
        setIncoming(payload.match);
        pushNotify({
          kind: 'community.match_found',
          threadKey: `match:${payload.match.id}:invite`,
          title: 'Convite · partida privada',
          body: payload.match.name || 'Nova partida',
        });
        try {
          window.sfDesktop?.focusWindow?.();
        } catch {
          /* ignore */
        }
      }
    };
    const onUpdated = (payload: MatchPayload) => applyMatch(payload.match);
    const onReadyCountdown = (payload: MatchPayload & { endsAt?: number }) => {
      if (!payload.match) return;
      applyMatch({
        ...payload.match,
        readyCountdownEndsAt:
          typeof payload.endsAt === 'number'
            ? payload.endsAt
            : payload.match.readyCountdownEndsAt,
        // Garante âncora fresca do servidor neste evento
        serverNow:
          typeof payload.match.serverNow === 'number'
            ? payload.match.serverNow
            : Date.now(),
      });
    };
    const onConnect = (payload: MatchPayload) => {
      applyMatch(payload.match);
      if (payload.match?.mode === 'host_listen' && payload.match.connect?.host) {
        setConnectPrompt(payload.match);
        if (isDesktop()) void tryAutoConnect(payload.match, true);
      }
    };
    const onVoteEnded = (payload: MatchPayload) => applyMatch(payload.match);
    const onValve = (payload: MatchPayload) => {
      applyMatch(payload.match);
      if (isDesktop()) void window.sfDesktop?.matchOpenCs2?.();
      pushNotify({
        kind: 'community.match_connect',
        threadKey: `match:${payload.match?.id || 'valve'}:valve`,
        title: 'Valve · abrir CS2',
        body: payload.poolCode || payload.match?.connect?.connectString || 'Entra na pool',
      });
    };
    const onEnded = (payload: MatchPayload) => applyMatch(payload.match);
    const onRooms = () => {
      if (!serverId) return;
      void api<{ matches?: PrivateMatch[] }>(`/api/private-match/server/${serverId}`)
        .then((data) => setServerRooms(data.matches || []))
        .catch(() => undefined);
    };

    sock.on('match.invite', onInvite);
    sock.on('match.updated', onUpdated);
    sock.on('match.vote_started', onUpdated);
    sock.on('match.vote_cast', onUpdated);
    sock.on('match.ready_countdown', onReadyCountdown);
    sock.on('match.connect', onConnect);
    sock.on('match.valve_start', onValve);
    sock.on('match.ended', onEnded);
    sock.on('match.vote_ended', onVoteEnded);
    sock.on('match.stats', onUpdated);
    sock.on('match.rooms', onRooms);

    return () => {
      sock.off('match.invite', onInvite);
      sock.off('match.updated', onUpdated);
      sock.off('match.vote_started', onUpdated);
      sock.off('match.vote_cast', onUpdated);
      sock.off('match.ready_countdown', onReadyCountdown);
      sock.off('match.connect', onConnect);
      sock.off('match.valve_start', onValve);
      sock.off('match.ended', onEnded);
      sock.off('match.vote_ended', onVoteEnded);
      sock.off('match.stats', onUpdated);
      sock.off('match.rooms', onRooms);
    };
  }, [enabled, userId, serverId, applyMatch, tryAutoConnect]);

  const refreshServerRooms = useCallback(async () => {
    if (!serverId) {
      setServerRooms([]);
      return;
    }
    try {
      const data = await api<{ matches?: PrivateMatch[] }>(`/api/private-match/server/${serverId}`);
      setServerRooms(data.matches || []);
    } catch {
      /* ignore */
    }
  }, [serverId]);

  useEffect(() => {
    void refreshServerRooms();
  }, [refreshServerRooms]);

  const create = useCallback(
    async (input: {
      mode: MatchMode;
      name?: string;
      room_password?: string;
      format?: string;
      mr?: number;
      hostname?: string;
      cheats?: boolean;
      port?: number;
      invite_ids?: number[];
      admin_settings?: NonNullable<PrivateMatch['adminSettings']>;
      match_pack_version?: string;
      welcome_message?: string;
      welcome_color?: string;
      sound_settings?: Record<string, unknown>;
    }) => {
      if (!serverId) throw new Error('Escolhe um servidor da comunidade');
      setBusy(true);
      setError('');
      const nextOpts: HostServerOpts = {
        hostname: String(input.hostname || input.name || 'SF-Private').trim().slice(0, 48),
        cheats: !!input.cheats,
        port: Number(input.port) > 0 ? Number(input.port) : 0,
        soundSettings:
          input.sound_settings && typeof input.sound_settings === 'object'
            ? input.sound_settings
            : undefined,
      };
      setHostOpts(nextOpts);
      hostOptsRef.current = nextOpts;
      try {
        const data = await api<{ match?: PrivateMatch }>('/api/private-match', {
          method: 'POST',
          body: JSON.stringify({
            server_id: serverId,
            mode: input.mode,
            name: input.name,
            room_password: input.room_password,
            format: input.format,
            mr: input.mr,
            invite_ids: input.invite_ids || [],
            admin_settings: input.admin_settings,
            match_pack_version: input.match_pack_version,
            welcome_message: input.welcome_message,
            welcome_color: input.welcome_color,
          }),
        });
        if (data.match) setActive(data.match);
        void refreshServerRooms();
        return data.match;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [serverId, refreshServerRooms],
  );

  const joinRoom = useCallback(async (matchId: string) => {
    setBusy(true);
    try {
      const data = await api<{ match?: PrivateMatch }>(`/api/private-match/${matchId}/join`, {
        method: 'POST',
        body: '{}',
      });
      if (data.match) setActive(data.match);
      return data.match;
    } finally {
      setBusy(false);
    }
  }, []);

  const spectate = useCallback(async (matchId: string) => {
    setBusy(true);
    try {
      const data = await api<{ match?: PrivateMatch }>(`/api/private-match/${matchId}/spectate`, {
        method: 'POST',
        body: '{}',
      });
      if (data.match) setActive(data.match);
      return data.match;
    } finally {
      setBusy(false);
    }
  }, []);

  const ingestGsi = useCallback(
    async (
      matchId: string,
      snap: {
        map?: { scoreCt?: number; scoreT?: number; round?: number; name?: string; phase?: string };
        player?: {
          name?: string;
          steamid?: string;
          team?: string;
          kills?: number;
          assists?: number;
          deaths?: number;
          mvps?: number;
          health?: number;
        };
        roster?: Array<{
          name: string;
          steamid: string;
          team: string;
          kills: number;
          assists: number;
          deaths: number;
          mvps?: number;
        }>;
      },
    ) => {
      try {
        const roster = [...(snap.roster || [])];
        if (
          snap.player?.name &&
          !roster.some(
            (r) =>
              (r.steamid &&
                snap.player?.steamid &&
                String(r.steamid).replace(/\D/g, '') ===
                  String(snap.player.steamid).replace(/\D/g, '')) ||
              r.name === snap.player?.name,
          )
        ) {
          roster.push({
            name: snap.player.name,
            steamid: snap.player.steamid || '',
            team: snap.player.team || '',
            kills: Number(snap.player.kills) || 0,
            assists: Number(snap.player.assists) || 0,
            deaths: Number(snap.player.deaths) || 0,
            mvps: Number(snap.player.mvps) || 0,
          });
        }
        await api(`/api/private-match/${matchId}/stats`, {
          method: 'POST',
          body: JSON.stringify({
            score_ct: snap.map?.scoreCt,
            score_t: snap.map?.scoreT,
            round: snap.map?.round,
            phase: snap.map?.phase || '',
            merge: true,
            stats: roster.map((p) => ({
              userId: 0,
              name: p.name,
              steamid: p.steamid,
              team: p.team,
              kills: p.kills,
              assists: p.assists,
              deaths: p.deaths,
              at: Date.now(),
            })),
          }),
        }).then((data: { match?: PrivateMatch }) => {
          if (data?.match) applyMatch(data.match);
        });
      } catch {
        /* ignore */
      }
    },
    [applyMatch],
  );

  const confirmConnect = useCallback(
    async (cs2Open: boolean) => {
      const m = connectPrompt || active;
      setConnectPrompt(null);
      if (!m?.connect) return;
      if (!cs2Open && isDesktop()) {
        await window.sfDesktop?.matchOpenCs2?.();
        await new Promise((r) => setTimeout(r, 4000));
      }
      await tryAutoConnect(m, true);
    },
    [connectPrompt, active, tryAutoConnect],
  );

  const invite = useCallback(async (matchId: string, targetId: number) => {
    setBusy(true);
    try {
      const data = await api<{ match?: PrivateMatch }>(`/api/private-match/${matchId}/invite`, {
        method: 'POST',
        body: JSON.stringify({ target_id: targetId }),
      });
      if (data.match) setActive(data.match);
    } finally {
      setBusy(false);
    }
  }, []);

  const respond = useCallback(async (matchId: string, accept: boolean) => {
    setBusy(true);
    try {
      const data = await api<{ match?: PrivateMatch }>(`/api/private-match/${matchId}/respond`, {
        method: 'POST',
        body: JSON.stringify({ accept }),
      });
      setIncoming(null);
      if (accept && data.match) setActive(data.match);
    } finally {
      setBusy(false);
    }
  }, []);

  const setReady = useCallback(async (matchId: string, ready: boolean) => {
    const data = await api<{ match?: PrivateMatch }>(`/api/private-match/${matchId}/ready`, {
      method: 'POST',
      body: JSON.stringify({ ready }),
    });
    if (data.match) setActive(data.match);
  }, []);

  const startVote = useCallback(async (matchId: string) => {
    const data = await api<{ match?: PrivateMatch }>(`/api/private-match/${matchId}/vote/start`, {
      method: 'POST',
      body: '{}',
    });
    if (data.match) setActive(data.match);
  }, []);

  const castVote = useCallback(async (matchId: string, mapId: string) => {
    const data = await api<{ match?: PrivateMatch }>(`/api/private-match/${matchId}/veto/ban`, {
      method: 'POST',
      body: JSON.stringify({ map_id: mapId }),
    });
    if (data.match) setActive(data.match);
  }, []);

  const pickVetoSide = useCallback(async (matchId: string, side: 'CT' | 'T') => {
    const data = await api<{ match?: PrivateMatch }>(`/api/private-match/${matchId}/veto/side`, {
      method: 'POST',
      body: JSON.stringify({ team: side }),
    });
    if (data.match) setActive(data.match);
  }, []);

  const endVote = useCallback(async (matchId: string) => {
    const data = await api<{ match?: PrivateMatch }>(`/api/private-match/${matchId}/vote/end`, {
      method: 'POST',
      body: '{}',
    });
    if (data.match) {
      setActive(data.match);
      syncTeamsToDedicated(data.match);
    }
  }, [syncTeamsToDedicated]);

  const hostSetTeam = useCallback(
    async (matchId: string, targetId: number, team: 'CT' | 'T' | 'SPEC') => {
      const data = await api<{ match?: PrivateMatch }>(`/api/private-match/${matchId}/host-team`, {
        method: 'POST',
        body: JSON.stringify({ target_id: targetId, team }),
      });
      if (data.match) {
        setActive(data.match);
        syncTeamsToDedicated(data.match);
      }
      return data;
    },
    [syncTeamsToDedicated],
  );

  const saveAdminSettings = useCallback(
    async (matchId: string, settings: NonNullable<PrivateMatch['adminSettings']>) => {
      const data = await api<{ match?: PrivateMatch }>(
        `/api/private-match/${matchId}/admin-settings`,
        {
          method: 'POST',
          body: JSON.stringify(settings),
        },
      );
      if (data.match) setActive(data.match);
      if (isDesktop() && window.sfDesktop?.matchAdminSettings) {
        await window.sfDesktop.matchAdminSettings(settings);
      }
      return data;
    },
    [],
  );

  const hostBootAndReady = useCallback(async (match: PrivateMatch) => {
    if (match.mode !== 'host_listen') return;
    const report = async (phase: string, message: string) => {
      setBootInfo({ phase, message, step: message });
      try {
        await api(`/api/private-match/${match.id}/boot-progress`, {
          method: 'POST',
          body: JSON.stringify({ phase, message }),
        });
      } catch {
        /* ignore */
      }
    };

    setBusy(true);
    await report('starting_dedicated', 'A iniciar dedicated…');
    let unsubProgress: (() => void) | undefined;
    try {
      if (!isDesktop() || !window.sfDesktop?.matchPrepareHost) {
        await report('failed', 'O PC host precisa do app Desktop.');
        return;
      }

      unsubProgress = window.sfDesktop.onMatchBootProgress?.((p) => {
        const msg = String(p?.message || p?.phase || 'A preparar…');
        setBootInfo({
          phase: String(p?.phase || 'booting'),
          message: msg,
          step: msg,
          pid: p?.pid,
          port: p?.port,
        });
        void api(`/api/private-match/${match.id}/boot-progress`, {
          method: 'POST',
          body: JSON.stringify({ phase: p?.phase || 'booting', message: msg }),
        }).catch(() => undefined);
      });

      const opts = hostOptsRef.current;
      await report('waiting_ready', 'A preparar overlay e dedicated…');

      let soundSettings: Record<string, unknown> | undefined =
        opts.soundSettings && typeof opts.soundSettings === 'object'
          ? opts.soundSettings
          : undefined;
      if (!soundSettings) {
        try {
          const prefs = await window.sfDesktop.matchSoundPrefsGet?.();
          if (prefs?.settings && typeof prefs.settings === 'object') {
            soundSettings = prefs.settings as Record<string, unknown>;
          }
        } catch {
          /* ignore */
        }
      }

      const prep = await window.sfDesktop.matchPrepareHost({
        password: match.roomPassword,
        map: match.votedMap || 'mirage',
        hostname: opts.hostname || match.name || `SF-PM`,
        cheats: opts.cheats,
        port: opts.port > 0 ? opts.port : 0,
        matchPackVersion: match.matchPackVersion || undefined,
        adminSettings: match.adminSettings || undefined,
        soundSettings,
        welcomeMessage: match.welcomeMessage || undefined,
        welcomeColor: match.welcomeColor || 'green',
        players: (match.players || [])
          .filter((p) => p.userId > 0 && !p.simulated)
          .map((p) => ({
            userId: p.userId,
            username: p.username,
            displayName: p.displayName,
            name: p.displayName || p.username,
            steamid: p.steamid || '',
            team: p.team,
          })),
      });

      setBootInfo({
        phase: prep?.phase || (prep?.ok ? 'listening' : 'failed'),
        message: prep?.message || prep?.error || (prep?.ok ? 'OK' : 'Falha'),
        step: prep?.ok
          ? `Dedicated ready · porta ${prep.port}`
          : prep?.message || 'Dedicated falhou',
        pid: prep?.pid,
        host: prep?.host,
        port: prep?.port,
        needsGslt: !!prep?.needsGslt,
        gsltUrl: prep?.gsltUrl,
        readyConfirmed: !!prep?.readyConfirmed,
      });

      if (!prep?.ok || !prep.readyConfirmed) {
        const detail = [prep?.message || prep?.error || 'Dedicated não ready'];
        if (prep?.logTail) {
          const fatal = String(prep.logTail).match(/FATAL ERROR:\s*(.+)/i);
          if (fatal?.[1] && !detail[0].includes(fatal[1].slice(0, 40))) {
            detail.push(fatal[1].trim().slice(0, 180));
          }
        }
        await report(prep?.needsGslt ? 'needs_gslt' : 'failed', detail.join(' — '));
        return;
      }

      const pubHost = String(prep.host || '').trim();
      const pubPort = Number(prep.port) || 0;
      await report(
        'publishing_connect',
        prep.upnpOk
          ? `Ready · ${pubHost}:${pubPort} (porta aberta no router)`
          : `Ready · ${pubHost}:${pubPort} — se os amigos falharem, abre UDP ${pubPort} no router.`,
      );

      const data = await api<{ match?: PrivateMatch }>(`/api/private-match/${match.id}/host-ready`, {
        method: 'POST',
        body: JSON.stringify({
          host: pubHost,
          port: pubPort,
          password: prep.password || match.roomPassword,
        }),
      });
      if (data.match) {
        setActive(data.match);
        if (data.match.connect) {
          setConnectPrompt(data.match);
          void tryAutoConnect(data.match, true);
        }
      }
    } finally {
      try {
        unsubProgress?.();
      } catch {
        /* ignore */
      }
      setBusy(false);
    }
  }, [tryAutoConnect]);

  useEffect(() => {
    if (!active || active.status !== 'host_booting') return;
    if (active.mode !== 'host_listen') return;
    if (active.hostUserId !== userId) return;
    if (!isDesktop()) return;
    const key = `${active.id}:${active.votedMap || ''}`;
    if (bootOnceRef.current === key) return;
    bootOnceRef.current = key;
    void hostBootAndReady(active);
  }, [active?.id, active?.status, active?.votedMap, active?.hostUserId, active?.mode, userId, hostBootAndReady, active]);

  useEffect(() => {
    if (!active?.connect?.host) return;
    if (active.status !== 'connecting' && active.status !== 'live') return;
    if (!isDesktop()) return;
    const key = `${active.id}:${active.connect.host}:${active.connect.port}`;
    if (connectOnceRef.current === key) return;
    connectOnceRef.current = key;
    setConnectPrompt(active);
    void tryAutoConnect(active, true);
  }, [active, tryAutoConnect]);

  const valveStart = useCallback(async (matchId: string) => {
    const data = await api<{ match?: PrivateMatch }>(`/api/private-match/${matchId}/valve-start`, {
      method: 'POST',
      body: '{}',
    });
    if (data.match) setActive(data.match);
    if (isDesktop()) void window.sfDesktop?.matchOpenCs2?.();
  }, []);

  const reconnect = useCallback(async () => {
    if (!isDesktop()) {
      pushNotify({
        kind: 'community.match_connect',
        threadKey: `match:reconnect:nodesktop`,
        title: 'Reconnect',
        body: 'Abre o app Desktop para reconnect automático.',
      });
      return;
    }

    if (
      active &&
      active.mode === 'host_listen' &&
      active.hostUserId === userId &&
      !active.connect?.host
    ) {
      connectingRef.current = false;
      bootOnceRef.current = '';
      await hostBootAndReady(active);
      return;
    }

    if (!active?.connect?.host) {
      pushNotify({
        kind: 'community.match_connect',
        threadKey: `match:reconnect:fail`,
        title: 'Reconnect',
        body: 'Ainda não há endpoint. Espera o dedicated do host.',
      });
      return;
    }

    if (active.hostUserId === userId && active.mode === 'host_listen') {
      const st = await window.sfDesktop?.matchDedicatedStatus?.();
      if (!st?.running) {
        connectingRef.current = false;
        bootOnceRef.current = '';
        await hostBootAndReady(active);
        return;
      }
    }

    if (!window.sfDesktop?.matchConnect) {
      pushNotify({
        kind: 'community.match_connect',
        threadKey: `match:reconnect:nodesktop`,
        title: 'Reconnect',
        body: 'IPC matchConnect indisponível — reinicia o Desktop.',
      });
      return;
    }
    connectingRef.current = false;
    connectOnceRef.current = '';
    const r = await tryAutoConnect(active, true);
    if (!r?.ok) {
      pushNotify({
        kind: 'community.match_connect',
        threadKey: `match:${active.id}:reconnect:err`,
        title: 'Reconnect falhou',
        body:
          (r as { error?: string; message?: string })?.message ||
          (r as { error?: string })?.error ||
          active.connect.connectString ||
          'Na consola: exec sf_pm_connect',
      });
    }
  }, [active, tryAutoConnect, userId, hostBootAndReady, ensureConsoleKey]);

  const end = useCallback(async (matchId?: string) => {
    const id = matchId || active?.id;
    if (!id) return;
    const snap = active;
    if (isDesktop() && snap) {
      try {
        let playersInServer: Array<{ name: string }> = [];
        try {
          const ds = await window.sfDesktop?.matchDedicatedSnapshot?.();
          playersInServer = ds?.playersInServer || [];
        } catch {
          /* ignore */
        }
        await window.sfDesktop?.matchHistoryPush?.({
          id: snap.id,
          name: snap.name,
          mode: snap.mode,
          map: snap.votedMap || snap.connect?.map || '',
          format: snap.format,
          scoreCt: snap.scoreCt,
          scoreT: snap.scoreT,
          players: snap.players.map((p) => ({
            name: p.displayName,
            team: p.team,
            userId: p.userId,
          })),
          stats: snap.stats,
          serverPlayers: playersInServer,
          connect: snap.connect,
          endedAt: Date.now(),
        });
      } catch {
        /* ignore */
      }
    }
    if (isDesktop() && snap?.hostUserId === userId) {
      try {
        await window.sfDesktop?.matchDedicatedStop?.();
      } catch {
        /* ignore */
      }
    }
    await api(`/api/private-match/${id}/end`, { method: 'POST', body: '{}' });
    setActive(null);
    setBootInfo(null);
  }, [active, userId]);

  return {
    incoming,
    active,
    busy,
    error,
    bootInfo,
    needsConsoleKey,
    hostOpts,
    setHostOpts,
    serverRooms,
    connectPrompt,
    create,
    invite,
    joinRoom,
    spectate,
    ingestGsi,
    confirmConnect,
    refreshServerRooms,
    respond,
    setReady,
    startVote,
    castVote,
    pickVetoSide,
    endVote,
    hostBootAndReady,
    hostSetTeam,
    saveAdminSettings,
    valveStart,
    reconnect,
    end,
    saveConsoleKey,
    ensureConsoleKey,
    clearIncoming: () => setIncoming(null),
    dismissConnectPrompt: () => setConnectPrompt(null),
    refresh,
  };
}
