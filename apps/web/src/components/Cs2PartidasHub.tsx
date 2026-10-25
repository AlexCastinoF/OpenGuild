import { useEffect, useMemo, useRef, useState } from 'react';
import { CirclePlay, Plus } from 'lucide-react';
import type { Cs2GsiSnapshot } from '../lib/cs2Gsi';
import type { BootInfo, HostServerOpts, PrivateMatch } from '../lib/privateMatch';
import { playAllReadyChime, playCountdownTick } from '../lib/matchLobbyFx';
import { useSyncedCountdown } from '../lib/useSyncedCountdown';
import {
  DedicatedMonitor,
  MatchAdminPanel,
  MatchHistoryPanel,
  MatchLobbyPanel,
  PmSpinner,
} from './PrivateMatchDialogs';

export type PartidasTab = 'hub' | 'lobby' | 'live' | 'host' | 'history';

type MemberLite = {
  id: number;
  display_name?: string;
  username?: string;
  label?: string;
  online?: boolean;
};

type Props = {
  match: PrivateMatch | null;
  serverRooms?: PrivateMatch[];
  serverId?: number;
  userId?: number;
  members?: MemberLite[];
  busy?: boolean;
  bootInfo?: BootInfo | null;
  hostOpts?: HostServerOpts;
  needsConsoleKey?: boolean;
  gsiSnap?: Cs2GsiSnapshot | null;
  gsiEnabled?: boolean;
  /** Incrementa ao aceitar convite / criar — força tab Lobby. */
  focusLobbyToken?: number;
  onOpenConsoleKey?: () => void;
  onCreate: () => void;
  onJoinRoom?: (matchId: string) => void;
  onSpectateRoom?: (matchId: string) => void;
  onOpenRoom?: (matchId: string) => void;
  onRefreshRooms?: () => void;
  onReady: (ready: boolean) => void;
  onInvite: (targetId: number) => void;
  onStartVote: () => void;
  onEndVote: () => void;
  onVote: (mapId: string) => void;
  onPickSide?: (side: 'CT' | 'T') => void;
  onHostBoot: () => void;
  onValveStart: () => void;
  onReconnect: () => void;
  onEnd: () => void;
};

function modeLabel(mode?: string) {
  if (mode === 'host_listen') return 'PC host';
  if (mode === 'vps') return 'Server VPS';
  return 'Valve';
}

function modeClass(mode?: string) {
  if (mode === 'host_listen') return 'is-dedi';
  if (mode === 'vps') return 'is-vps';
  return 'is-valve';
}

function Countdown(props: { left: number }) {
  return <strong>{props.left}s</strong>;
}

function ReadyCountdownOverlay(props: { left: number }) {
  const startedRef = useRef(false);
  const lastSec = useRef<number | null>(null);

  useEffect(() => {
    if (!startedRef.current && props.left > 0) {
      startedRef.current = true;
      playAllReadyChime();
    }
  }, [props.left]);

  useEffect(() => {
    if (lastSec.current !== null && props.left < lastSec.current && props.left > 0 && props.left <= 5) {
      playCountdownTick();
    }
    lastSec.current = props.left;
  }, [props.left]);

  if (props.left <= 0) return null;

  return (
    <div className="pm-ready-overlay" role="dialog" aria-live="assertive" aria-label="Contagem para veto">
      <div className="pm-ready-overlay-card">
        <p className="pm-ready-overlay-kicker">Todos prontos</p>
        <div className="pm-ready-overlay-num" key={props.left}>
          {props.left}
        </div>
        <p className="pm-ready-overlay-lead">Votação de mapas a começar…</p>
      </div>
    </div>
  );
}

function PmBootStatus(props: { phase: string; message: string }) {
  return (
    <div className="cs2-boot-card">
      <div className="cs2-boot-spin" aria-hidden />
      <div>
        <strong>{props.phase}</strong>
        <p>{props.message}</p>
      </div>
    </div>
  );
}

function LiveScoreboard(props: {
  snap: Cs2GsiSnapshot | null | undefined;
  match: PrivateMatch | null;
  userId?: number;
  isHost?: boolean;
}) {
  const snap = props.snap;
  const match = props.match;
  const [kickBusy, setKickBusy] = useState<string | null>(null);
  const [kickMsg, setKickMsg] = useState('');

  const gsiBySteam = new Map<string, NonNullable<Cs2GsiSnapshot['roster']>[0]>();
  const gsiByName = new Map<string, NonNullable<Cs2GsiSnapshot['roster']>[0]>();
  for (const r of snap?.roster || []) {
    const sid = String(r.steamid || '').replace(/\D/g, '');
    if (sid) gsiBySteam.set(sid, r);
    const nm = String(r.name || '').trim().toLowerCase();
    if (nm) gsiByName.set(nm, r);
  }
  if (snap?.player?.name) {
    const self = {
      name: snap.player.name,
      steamid: snap.player.steamid,
      team: snap.player.team,
      kills: snap.player.kills,
      assists: snap.player.assists,
      deaths: snap.player.deaths,
      mvps: snap.player.mvps,
      health: snap.player.health,
    };
    const sid = String(self.steamid || '').replace(/\D/g, '');
    if (sid) gsiBySteam.set(sid, self);
    const nm = String(self.name || '').trim().toLowerCase();
    if (nm) gsiByName.set(nm, self);
  }

  const resolveGsi = (steamid: string, nameKey: string) => {
    if (steamid && gsiBySteam.has(steamid)) return gsiBySteam.get(steamid);
    if (nameKey && gsiByName.has(nameKey)) return gsiByName.get(nameKey);
    // "Alex Castino" no lobby vs persona "ALEX" no CS2
    if (nameKey) {
      const first = nameKey.split(/\s+/)[0] || '';
      if (first.length >= 3 && gsiByName.has(first)) return gsiByName.get(first);
      for (const [nm, row] of gsiByName) {
        if (nm.length >= 3 && (nameKey.startsWith(nm) || nm.startsWith(first))) return row;
      }
    }
    return undefined;
  };

  const statsBySteam = new Map<string, NonNullable<PrivateMatch['stats']>[number]>();
  const statsByName = new Map<string, NonNullable<PrivateMatch['stats']>[number]>();
  const statsByUser = new Map<number, NonNullable<PrivateMatch['stats']>[number]>();
  for (const s of match?.stats || []) {
    const sid = String(s.steamid || '').replace(/\D/g, '');
    if (sid) statsBySteam.set(sid, s);
    const nm = String(s.name || '').trim().toLowerCase();
    if (nm) statsByName.set(nm, s);
    if (Number(s.userId) > 0) statsByUser.set(Number(s.userId), s);
  }

  type Row = {
    key: string;
    name: string;
    steamid: string;
    userId?: number;
    team: string;
    kills: number;
    assists: number;
    deaths: number;
    mvps: number;
    isSelf: boolean;
    /** null = desconhecido; true/false só com GSI fresco */
    alive?: boolean | null;
    /** Ainda no GSI/server agora */
    present: boolean;
    /** Já esteve na partida (sticky até acabar) */
    sticky: boolean;
  };

  const roster: Row[] = [];
  /** Identidades já listadas — u:/s:/n: para não duplicar GSI + lobby + stats */
  const seen = new Set<string>();

  const identityKeys = (row: Pick<Row, 'userId' | 'steamid' | 'name' | 'key'>) => {
    const keys: string[] = [];
    if (row.userId && row.userId > 0) keys.push(`u:${row.userId}`);
    const sid = String(row.steamid || '').replace(/\D/g, '');
    if (sid) keys.push(`s:${sid}`);
    const nm = String(row.name || '')
      .trim()
      .toLowerCase();
    if (nm) keys.push(`n:${nm}`);
    if (row.key) keys.push(row.key);
    return keys;
  };

  const findExisting = (row: Row) => {
    const sid = String(row.steamid || '').replace(/\D/g, '');
    const nm = String(row.name || '')
      .trim()
      .toLowerCase();
    const first = (nm.split(/\s+/)[0] || '').trim();
    return roster.findIndex((r) => {
      if (row.userId && row.userId > 0 && r.userId === row.userId) return true;
      if (sid && r.steamid && r.steamid === sid) return true;
      const rn = String(r.name || '')
        .trim()
        .toLowerCase();
      if (!nm || !rn) return false;
      if (rn === nm) return true;
      // Persona CS2 "ALEX" vs display "Alex Castino"
      if (rn.startsWith(`${nm} `) || nm.startsWith(`${rn} `)) return true;
      const rFirst = (rn.split(/\s+/)[0] || '').trim();
      if (first.length >= 3 && rFirst === first) return true;
      return false;
    });
  };

  const maxNum = (a: unknown, b: unknown) => Math.max(Number(a) || 0, Number(b) || 0);

  const pushRow = (row: Row) => {
    const keys = identityKeys(row);
    if (!keys.length) return;

    const idx = findExisting(row);
    if (idx >= 0) {
      const cur = roster[idx];
      // Preferir nome do lobby (mais longo) se o GSI só manda persona curta
      const preferName =
        row.userId && (!cur.userId || cur.name.length < row.name.length)
          ? row.name
          : cur.name.length >= row.name.length
            ? cur.name
            : row.name;
      roster[idx] = {
        ...cur,
        name: preferName,
        steamid: cur.steamid || row.steamid,
        userId: cur.userId || row.userId,
        team: row.present ? row.team : cur.team || row.team,
        kills: maxNum(cur.kills, row.kills),
        assists: maxNum(cur.assists, row.assists),
        deaths: maxNum(cur.deaths, row.deaths),
        mvps: maxNum(cur.mvps, row.mvps),
        isSelf: cur.isSelf || row.isSelf,
        present: cur.present || row.present,
        sticky: true,
        alive: row.present
          ? row.alive
          : cur.present
            ? cur.alive
            : row.alive ?? cur.alive ?? null,
      };
      for (const k of identityKeys(roster[idx])) seen.add(k);
      return;
    }

    if (keys.some((k) => seen.has(k))) return;
    for (const k of keys) seen.add(k);
    roster.push({ ...row, key: keys[0] });
  };

  // 1) Jogadores da partida — sticky se já entraram / têm stats
  for (const p of match?.players || []) {
    if (p.simulated || p.userId < 0) continue;
    if (p.inviteStatus !== 'host' && p.inviteStatus !== 'accepted') continue;
    if (p.team === 'SPEC') continue;
    const sid = String(p.steamid || '').replace(/\D/g, '');
    const nameKey = (p.displayName || p.username || '').trim().toLowerCase();
    const g = resolveGsi(sid, nameKey);
    const st =
      (p.userId > 0 ? statsByUser.get(p.userId) : undefined) ||
      (sid ? statsBySteam.get(sid) : undefined) ||
      (nameKey ? statsByName.get(nameKey) : undefined) ||
      (nameKey
        ? statsByName.get(nameKey.split(/\s+/)[0] || '')
        : undefined);
    const present = !!g;
    const sticky = !!(present || p.inServer || p.connected || st);
    // Só lista quem já esteve / está — convidados que nunca entraram ficam de fora do placar
    if (!sticky && match?.status !== 'live' && match?.status !== 'connecting') continue;
    if (!sticky && !present) continue;

    const teamRaw = String(g?.team || p.gameTeam || p.team || 'T').toUpperCase();
    const team = teamRaw === 'CT' ? 'CT' : 'T';
    // Vivo/morto: só com HP fresco do GSI; se saiu da sala, não marcar morto
    const alive =
      present && typeof g?.health === 'number'
        ? g.health > 0
        : present && typeof p.alive === 'boolean'
          ? p.alive
          : null;

    pushRow({
      key: `u:${p.userId}`,
      name: p.displayName || p.username || g?.name || 'Jogador',
      steamid: sid || String(g?.steamid || st?.steamid || ''),
      userId: p.userId,
      team,
      kills: maxNum(g?.kills ?? 0, st?.kills ?? 0),
      assists: maxNum(g?.assists ?? 0, st?.assists ?? 0),
      deaths: maxNum(g?.deaths ?? 0, st?.deaths ?? 0),
      mvps: Number(g?.mvps ?? 0) || 0,
      isSelf: p.userId === props.userId,
      alive,
      present,
      sticky: true,
    });
  }

  // 2) Extra do GSI / stats que não estão no roster da partida (bots, etc.)
  for (const g of [...gsiBySteam.values()]) {
    const team = String(g.team || '').toUpperCase();
    if (team === 'SPEC' || !g.name) continue;
    pushRow({
      key: `g:${String(g.steamid || g.name).toLowerCase()}`,
      name: g.name,
      steamid: String(g.steamid || '').replace(/\D/g, ''),
      team: team === 'CT' ? 'CT' : 'T',
      kills: Number(g.kills) || 0,
      assists: Number(g.assists) || 0,
      deaths: Number(g.deaths) || 0,
      mvps: Number(g.mvps) || 0,
      isSelf: false,
      alive: typeof g.health === 'number' ? g.health > 0 : null,
      present: true,
      sticky: true,
    });
  }

  for (const s of match?.stats || []) {
    if (!s.name) continue;
    const team = String(s.team || '').toUpperCase();
    if (team === 'SPEC') continue;
    pushRow({
      key: `s:${String(s.steamid || s.userId || s.name).toLowerCase()}`,
      name: String(s.name),
      steamid: String(s.steamid || '').replace(/\D/g, ''),
      userId: Number(s.userId) > 0 ? Number(s.userId) : undefined,
      team: team === 'CT' ? 'CT' : 'T',
      kills: Number(s.kills) || 0,
      assists: Number(s.assists) || 0,
      deaths: Number(s.deaths) || 0,
      mvps: 0,
      isSelf: false,
      alive: null,
      present: false,
      sticky: true,
    });
  }

  const ct = roster
    .filter((p) => String(p.team).toUpperCase() === 'CT')
    .sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name));
  const t = roster
    .filter((p) => String(p.team).toUpperCase() !== 'CT')
    .sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name));

  const scoreCt = snap?.map.scoreCt ?? match?.scoreCt ?? 0;
  const scoreT = snap?.map.scoreT ?? match?.scoreT ?? 0;
  const mapName =
    snap?.map.name || match?.votedMap || match?.connect?.map || '—';
  const round = snap?.map.round ?? match?.round ?? 0;
  const gsiFresh = !!(snap && Date.now() - (snap.at || 0) < 20000);
  const matchLive = match?.status === 'live' || match?.status === 'connecting';
  const sourceLabel = gsiFresh ? 'GSI' : matchLive ? 'partida' : roster.length ? 'roster' : 'à espera';
  const phase =
    snap?.round?.phase ||
    snap?.map.phase ||
    (matchLive ? 'live' : '—');

  async function kickPlayer(row: Row) {
    if (!props.isHost || !window.sfDesktop?.matchDedicatedExec) {
      setKickMsg('Kick só no Desktop do host com dedicated a correr.');
      return;
    }
    const token = row.steamid || row.name;
    setKickBusy(token);
    setKickMsg('');
    try {
      const safeName = String(row.name || '').replace(/"/g, '');
      // Preferir nome (kickid precisa do userid do status, não do SteamID64)
      const cmd = safeName ? `kick "${safeName}"` : '';
      if (!cmd) {
        setKickMsg('Sem nome para kick.');
        return;
      }
      const r = await window.sfDesktop.matchDedicatedExec(cmd);
      if (r && r.ok === false) {
        setKickMsg(`Kick falhou: ${String((r as { error?: string }).error || 'erro')}`);
      } else {
        setKickMsg(`Kick enviado: ${safeName}`);
      }
    } catch (e) {
      setKickMsg(e instanceof Error ? e.message : 'Falha no kick');
    } finally {
      setKickBusy(null);
    }
  }

  function statusBadge(p: Row) {
    if (p.present && p.alive === false) {
      return <span className="pm-presence is-dead">morto</span>;
    }
    if (p.present && p.alive === true) {
      return <span className="pm-presence is-alive">vivo</span>;
    }
    if (p.sticky && !p.present) {
      return <span className="pm-presence is-off">fora</span>;
    }
    return null;
  }

  function table(team: string, rows: Row[], side: 'ct' | 't') {
    return (
      <div className={`cs2-partidas-team-card is-${side}`}>
        <table className="cs2-partidas-table">
          <thead>
            <tr>
              <th>{team}</th>
              <th className="num">K</th>
              <th className="num">A</th>
              <th className="num">D</th>
              <th className="num">MVP</th>
              {props.isHost ? <th className="act"> </th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((p) => (
                <tr
                  key={p.key}
                  className={`${p.isSelf ? 'is-you' : ''}${!p.present ? ' is-away' : ''}`.trim()}
                >
                  <td>
                    <span className="cs2-partidas-player-name">
                      {p.name}
                      {statusBadge(p)}
                    </span>
                  </td>
                  <td className="num">{p.kills}</td>
                  <td className="num">{p.assists}</td>
                  <td className="num">{p.deaths}</td>
                  <td className="num">{p.mvps ?? 0}</td>
                  {props.isHost ? (
                    <td className="act">
                      <button
                        type="button"
                        className="btn btn-sm cs2-partidas-kick"
                        disabled={!!kickBusy || p.userId === props.userId}
                        title={p.userId === props.userId ? 'Não podes kickar-te' : `Kick ${p.name}`}
                        onClick={() => void kickPlayer(p)}
                      >
                        {kickBusy === (p.steamid || p.name) ? '…' : 'Kick'}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={props.isHost ? 6 : 5} className="muted">
                  {match ? 'À espera de jogadores no server' : 'Sem roster ainda'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  if (!snap && !match) {
    return (
      <div className="cs2-partidas-empty">
        <h3>Nada ao vivo</h3>
        <p>Abre o CS2 com GSI ativo, ou cria uma partida no lobby.</p>
      </div>
    );
  }

  return (
    <div className="cs2-partidas-live">
      <div className="cs2-partidas-score">
        <span className="side ct">CT</span>
        <strong>
          {scoreCt}
          <span>–</span>
          {scoreT}
        </strong>
        <span className="side t">T</span>
      </div>
      <p className="cs2-partidas-round">
        {mapName} · round {round} · {phase} · {sourceLabel}
        {props.isHost ? ' · kick no dedicated' : ''}
      </p>
      {kickMsg ? (
        <p className="cs2-partidas-note" role="status">
          {kickMsg}
        </p>
      ) : null}
      <div className="cs2-partidas-live-teams">
        {table('CT', ct, 'ct')}
        {table('TR', t, 't')}
      </div>
    </div>
  );
}

export function Cs2PartidasHub(props: Props) {
  const [tab, setTab] = useState<PartidasTab>(props.match ? 'lobby' : 'hub');
  const countdownLeft = useSyncedCountdown(
    props.match?.status === 'lobby' ? props.match.readyCountdownEndsAt : 0,
    props.match?.serverNow,
  );
  const showCountdown =
    props.match?.status === 'lobby' &&
    !!props.match.readyCountdownEndsAt &&
    countdownLeft > 0;

  const [waitingLobby, setWaitingLobby] = useState(false);

  useEffect(() => {
    if (!props.match?.id) return;
    setTab('lobby');
    setWaitingLobby(false);
    try {
      const forced = sessionStorage.getItem('sf_force_partidas_lobby');
      if (forced && forced === props.match.id) {
        sessionStorage.removeItem('sf_force_partidas_lobby');
      }
    } catch {
      /* ignore */
    }
  }, [props.match?.id]);

  useEffect(() => {
    if (props.match?.status === 'lobby') setTab('lobby');
  }, [props.match?.status, props.match?.id]);

  useEffect(() => {
    if (props.focusLobbyToken && props.focusLobbyToken > 0) {
      setTab('lobby');
      setWaitingLobby(true);
      const t = window.setTimeout(() => setWaitingLobby(false), 12000);
      return () => window.clearTimeout(t);
    }
  }, [props.focusLobbyToken]);

  useEffect(() => {
    if (props.match) setWaitingLobby(false);
  }, [props.match]);

  const dediLive =
    props.match?.mode === 'host_listen' &&
    (props.match.status === 'connecting' ||
      props.match.status === 'live' ||
      props.match.status === 'host_booting');

  const isHost = props.match?.hostUserId === props.userId;

  const membersForLobby = useMemo(
    () =>
      (props.members || []).map((m) => ({
        id: m.id,
        display_name: m.display_name || m.label,
        username: m.username,
        label: m.label,
        online: !!m.online,
      })),
    [props.members],
  );

  const openTab = (next: PartidasTab) => {
    if (next === 'lobby' && !props.match) {
      props.onCreate();
      return;
    }
    setTab(next);
  };

  return (
    <div className={`cs2-partidas-hub${props.match?.status === 'voting' ? ' is-vetoing' : ''}`}>
      {showCountdown ? <ReadyCountdownOverlay left={countdownLeft} /> : null}
      <header className="cs2-partidas-head">
        <div className="cs2-partidas-head-title">
          <span className="cs2-partidas-icon" aria-hidden>
            <CirclePlay size={18} />
          </span>
          <div>
            <p className="cs2-partidas-kicker">Canal · competitivo</p>
            <h1>Partidas</h1>
          </div>
        </div>
        <div className="cs2-partidas-head-meta">
          {props.match ? (
            <span className={`cs2-partidas-badge ${modeClass(props.match.mode)}`}>
              {modeLabel(props.match.mode)}
            </span>
          ) : null}
          {props.match?.status === 'live' || props.gsiSnap ? (
            <span className="cs2-partidas-badge is-live">LIVE</span>
          ) : null}
        </div>
      </header>

      <nav className="cs2-partidas-tabs" aria-label="Secções Partidas">
        {(
          [
            ['hub', 'Início'],
            ['lobby', 'Lobby'],
            ['live', 'Ao vivo'],
            ['host', 'Host'],
            ['history', 'Histórico'],
          ] as Array<[PartidasTab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`cs2-partidas-tab${tab === id ? ' is-on' : ''}`}
            onClick={() => openTab(id)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          className="cs2-partidas-tab cs2-partidas-tab-cta"
          onClick={props.onCreate}
        >
          <Plus size={14} /> Nova
        </button>
      </nav>

      <div className="cs2-partidas-body">
        {tab === 'hub' ? (
          <div className="cs2-partidas-frame">
            {(props.match?.status === 'host_booting' ||
              props.match?.status === 'connecting' ||
              props.match?.bootPhase) &&
            props.match.status !== 'live' &&
            props.match.status !== 'lobby' &&
            props.match.status !== 'voting' ? (
              <div className="cs2-partidas-loading">
                <PmBootStatus
                  phase={props.match.bootPhase || props.bootInfo?.phase || props.match.status}
                  message={
                    props.match.bootMessage ||
                    props.bootInfo?.message ||
                    'A preparar server…'
                  }
                />
              </div>
            ) : null}

            {showCountdown ? (
              <div className="cs2-partidas-countdown">
                Todos prontos — veto em <Countdown left={countdownLeft} />
              </div>
            ) : null}

            {props.match ? (
              <div className="cs2-partidas-active">
                <div>
                  <span className={`cs2-partidas-badge ${modeClass(props.match.mode)}`}>
                    {modeLabel(props.match.mode)}
                  </span>
                  <h2>{props.match.name || 'Partida ativa'}</h2>
                  <p>
                    {props.match.status}
                    {props.gsiSnap
                      ? ` · ${props.gsiSnap.map.name} ${props.gsiSnap.map.scoreCt}–${props.gsiSnap.map.scoreT}`
                      : props.match.votedMap
                        ? ` · ${props.match.votedMap}`
                        : ''}
                  </p>
                </div>
                <div className="cs2-partidas-actions">
                  <button type="button" className="btn btn-primary" onClick={() => setTab('lobby')}>
                    Abrir lobby
                  </button>
                  <button type="button" className="btn" onClick={() => setTab('live')}>
                    Ao vivo
                  </button>
                  <button type="button" className="btn" onClick={() => setTab('host')}>
                    Host
                  </button>
                </div>
              </div>
            ) : null}

            <div className="cs2-partidas-rooms">
              <div className="cs2-partidas-rooms-head">
                <h3>Salas neste servidor</h3>
                <div className="cs2-partidas-actions" style={{ flexDirection: 'row' }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => props.onRefreshRooms?.()}
                  >
                    Atualizar
                  </button>
                  <button type="button" className="btn btn-sm btn-primary" onClick={props.onCreate}>
                    <Plus size={14} /> Nova
                  </button>
                </div>
              </div>
              {(props.serverRooms || []).length === 0 ? (
                <div className="cs2-partidas-empty">
                  <h3>Nenhuma sala aberta</h3>
                  <p>Cria uma partida com o wizard (modo → opções → convidar).</p>
                  <button type="button" className="btn btn-primary" onClick={props.onCreate}>
                    Nova partida
                  </button>
                </div>
              ) : (
                <ul className="cs2-partidas-room-list">
                  {(props.serverRooms || []).map((r) => {
                    const n = r.players.filter(
                      (p) =>
                        p.team !== 'SPEC' &&
                        (p.inviteStatus === 'host' || p.inviteStatus === 'accepted'),
                    ).length;
                    const mine = r.id === props.match?.id || r.isMember;
                    const live = r.status === 'live' || r.status === 'connecting';
                    return (
                      <li key={r.id}>
                        <div>
                          <strong>{r.name}</strong>
                          <span>
                            {modeLabel(r.mode)} · {r.status} · {n} jogadores
                            {live ? ` · ${r.scoreCt}:${r.scoreT}` : ''}
                          </span>
                        </div>
                        <div className="cs2-partidas-room-actions">
                          {mine ? (
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => {
                                props.onOpenRoom?.(r.id);
                                setTab(live ? 'live' : 'lobby');
                              }}
                            >
                              {live ? 'Stats' : 'Abrir'}
                            </button>
                          ) : r.youPending || r.canJoin ? (
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              disabled={props.busy || r.status === 'ended'}
                              onClick={() => props.onJoinRoom?.(r.id)}
                            >
                              Entrar
                            </button>
                          ) : r.canWatch ? (
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={props.busy}
                              onClick={() => {
                                props.onSpectateRoom?.(r.id);
                                setTab('live');
                              }}
                            >
                              Assistir
                            </button>
                          ) : (
                            <button type="button" className="btn btn-sm" disabled>
                              Só convidados
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        ) : null}

        {tab === 'lobby' && props.match ? (
          <MatchLobbyPanel
            match={props.match}
            userId={props.userId}
            members={membersForLobby}
            busy={props.busy}
            bootInfo={props.bootInfo}
            hostOpts={props.hostOpts}
            needsConsoleKey={props.needsConsoleKey}
            gsiSnap={props.gsiSnap}
            focusLobbyToken={props.focusLobbyToken}
            onOpenConsoleKey={props.onOpenConsoleKey}
            onReady={props.onReady}
            onInvite={props.onInvite}
            onStartVote={props.onStartVote}
            onEndVote={props.onEndVote}
            onVote={props.onVote}
            onPickSide={props.onPickSide}
            onHostBoot={props.onHostBoot}
            onValveStart={props.onValveStart}
            onReconnect={props.onReconnect}
            onEnd={() => {
              props.onEnd();
              setTab('hub');
            }}
          />
        ) : null}

        {tab === 'lobby' && !props.match ? (
          waitingLobby ? (
            <div className="cs2-partidas-empty">
              <PmSpinner label="A abrir lobby…" sub="A sincronizar o convite aceite" />
            </div>
          ) : (
            <div className="cs2-partidas-empty">
              <h3>Sem lobby</h3>
              <p>Cria uma partida para abrir o lobby neste canal.</p>
              <button type="button" className="btn btn-primary" onClick={props.onCreate}>
                Nova partida
              </button>
            </div>
          )
        ) : null}

        {tab === 'live' ? (
          <div className="cs2-partidas-frame">
            {!props.gsiEnabled ? (
              <p className="cs2-partidas-note">
                GSI desligado — ativa em Perfil → Histórico CS2 / GSI para ver o placar do jogo.
              </p>
            ) : null}
            <LiveScoreboard
              snap={props.gsiSnap}
              match={props.match}
              userId={props.userId}
              isHost={!!isHost}
            />
          </div>
        ) : null}

        {tab === 'host' ? (
          <div className="cs2-partidas-frame">
            {props.match?.mode === 'valve' ? (
              <div className="cs2-partidas-empty">
                <h3>Modo Valve</h3>
                <p>Sem consola de dedicated. Usa o placar GSI em Ao vivo.</p>
                <button type="button" className="btn" onClick={() => setTab('live')}>
                  Ir ao vivo
                </button>
              </div>
            ) : (
              <>
                <p className="cs2-partidas-note">
                  {isHost
                    ? 'Admin e consola do dedicated local.'
                    : 'Só o host pode administrar o dedicated. Vê o placar em Ao vivo ou o connect no Lobby.'}
                </p>
                {isHost &&
                props.match &&
                (props.match.status === 'host_booting' ||
                  props.match.status === 'connecting' ||
                  props.match.status === 'live') ? (
                  <div style={{ marginBottom: 14 }}>
                    <MatchAdminPanel match={props.match} gsiSnap={props.gsiSnap} />
                  </div>
                ) : null}
                {isHost ? (
                  <DedicatedMonitor active={!!dediLive} isHost />
                ) : (
                  <div className="cs2-partidas-empty" style={{ marginTop: 12 }}>
                    <h3>Sem consola no teu PC</h3>
                    <p>O dedicated corre no host. Usa Lobby para reconnect ou Ao vivo para o placar.</p>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                      <button type="button" className="btn" onClick={() => setTab('lobby')}>
                        Ir ao lobby
                      </button>
                      <button type="button" className="btn btn-primary" onClick={() => setTab('live')}>
                        Ao vivo
                      </button>
                    </div>
                  </div>
                )}
                {isHost && !dediLive ? (
                  <div className="cs2-partidas-empty" style={{ marginTop: 12 }}>
                    <h3>Dedicated parado</h3>
                    <p>Sobe o server no lobby (voto de mapa → host boot) para usar o monitor.</p>
                    <button type="button" className="btn" onClick={() => setTab('lobby')}>
                      Ir ao lobby
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        {tab === 'history' ? (
          <MatchHistoryPanel open serverId={props.serverId || props.match?.serverId} />
        ) : null}
      </div>
    </div>
  );
}
