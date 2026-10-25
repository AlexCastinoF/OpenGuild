/**
 * Histórico local de partidas CS2 a partir do GSI (userData JSON).
 * Sem API VPS — ficheiro no PC do utilizador.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_MATCHES = 80;
const MAX_EVENTS = 400;
const UPSERT_MIN_MS = 1200;

/** @type {string} */
let historyFile = '';
/** @type {object | null} */
let live = null;
/** @type {(match: object) => void} */
let onMatchSaved = () => {};
let lastUpsertAt = 0;

function configure(opts) {
  const dir = String(opts?.userDataPath || '').trim();
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  historyFile = path.join(dir, 'cs2-gsi-history.json');
}

function setMatchSavedHandler(fn) {
  onMatchSaved = typeof fn === 'function' ? fn : () => {};
}

function readStore() {
  if (!historyFile) return { matches: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    return { matches: Array.isArray(raw.matches) ? raw.matches : [] };
  } catch {
    return { matches: [] };
  }
}

function writeStore(store) {
  if (!historyFile) return;
  fs.writeFileSync(historyFile, JSON.stringify(store, null, 2), 'utf8');
}

function listMatches(limit = 40) {
  const n = Math.max(1, Math.min(100, Number(limit) || 40));
  return readStore().matches.slice(0, n);
}

function getMatch(id) {
  return readStore().matches.find((m) => m.id === id) || null;
}

function clearMatches() {
  writeStore({ matches: [] });
  return { ok: true };
}

/**
 * Funde detalhe Valve (sharecode/GC) numa partida GSI local.
 * Não grava .dem — só meta + demo_url + roster Valve se GSI não tiver nomes.
 */
function mergeValveDetail(matchId, valve) {
  const id = String(matchId || '').trim();
  if (!id || !valve || typeof valve !== 'object') {
    return { ok: false, error: 'invalid' };
  }
  const store = readStore();
  const idx = store.matches.findIndex((m) => m.id === id);
  if (idx < 0) return { ok: false, error: 'not_found' };
  const m = { ...store.matches[idx] };
  const detail = valve.detail || valve;
  m.valve = {
    share_code: valve.share_code || detail.share_code || '',
    match_id: detail.match_id || '',
    demo_url: detail.demo_url || valve.demo_url || '',
    map: detail.map || detail.mapname || '',
    scoreCt: detail.score_ct ?? detail.scoreCt,
    scoreT: detail.score_t ?? detail.scoreT,
    enrichedAt: Date.now(),
  };
  if (m.valve.map && (!m.map || m.map === 'unknown')) m.map = String(m.valve.map);
  if (m.valve.scoreCt != null && m.scoreCt == null) m.scoreCt = Number(m.valve.scoreCt) || 0;
  if (m.valve.scoreT != null && m.scoreT == null) m.scoreT = Number(m.valve.scoreT) || 0;

  const valvePlayers = [
    ...(Array.isArray(detail.allies) ? detail.allies : []),
    ...(Array.isArray(detail.enemies) ? detail.enemies : []),
    ...(Array.isArray(detail.players) ? detail.players : []),
  ];
  if (valvePlayers.length && (!(m.roster || []).some((p) => p.name && !p.isSelf) || !m.hadAllplayers)) {
    const bySteam = new Map((m.roster || []).map((p) => [String(p.steamid || ''), p]));
    for (const p of valvePlayers) {
      const sid = String(p.steamid64 || p.steamid || '');
      const name = p.persona_name || p.name || '';
      const team = p.team || '';
      if (!sid && !name) continue;
      const prev = bySteam.get(sid) || {};
      bySteam.set(sid, {
        ...prev,
        name: name || prev.name || '',
        steamid: sid || prev.steamid || '',
        team: team || prev.team || '',
        kills: Number(p.kills ?? prev.kills) || 0,
        assists: Number(p.assists ?? prev.assists) || 0,
        deaths: Number(p.deaths ?? prev.deaths) || 0,
        mvps: Number(p.mvps ?? prev.mvps) || 0,
        isSelf: !!prev.isSelf,
        fromValve: true,
      });
    }
    m.roster = [...bySteam.values()];
  }

  store.matches[idx] = m;
  writeStore(store);
  return { ok: true, match: m };
}

function rosterFromAllplayers(allplayers) {
  if (!allplayers || typeof allplayers !== 'object') return [];
  return Object.values(allplayers).map((p) => {
    const st = p?.match_stats || {};
    return {
      name: p?.name || '',
      steamid: p?.steamid || '',
      team: p?.team || '',
      kills: Number(st.kills) || 0,
      assists: Number(st.assists) || 0,
      deaths: Number(st.deaths) || 0,
      mvps: Number(st.mvps) || 0,
      score: Number(st.score) || 0,
    };
  });
}

function publicMatch(match) {
  if (!match) return null;
  const { _prev, ...rest } = match;
  return rest;
}

/** Grava/actualiza a partida no ficheiro enquanto ainda está a decorrer. */
function upsertLiveToStore(force = false) {
  if (!live || !historyFile) return;
  const now = Date.now();
  if (!force && now - lastUpsertAt < UPSERT_MIN_MS) return;
  lastUpsertAt = now;

  live.status = 'live';
  live.updatedAt = now;
  live.durationSec = Math.max(0, Math.round((now - live.startedAt) / 1000));
  live.endedAt = null;
  live.endReason = '';
  live.result = live.result || '';

  // Sugestão futura de cruzamento 1x1 (NÃO é ID Valve — só pista local)
  const steamids = [...new Set((live.roster || []).map((p) => p.steamid).filter(Boolean))].sort();
  live.correlationHint = {
    mapRaw: live.mapRaw || live.map || '',
    startedBucket: Math.floor(live.startedAt / 60_000),
    steamids,
  };

  const saved = publicMatch(live);
  const store = readStore();
  store.matches = [saved, ...store.matches.filter((m) => m.id !== saved.id)].slice(0, MAX_MATCHES);
  writeStore(store);
  try {
    onMatchSaved(saved);
  } catch {
    /* ignore */
  }
}

function startMatch(snap) {
  live = {
    id: crypto.randomBytes(8).toString('hex'),
    status: 'live',
    startedAt: snap.at || Date.now(),
    updatedAt: snap.at || Date.now(),
    endedAt: null,
    endReason: '',
    map: snap.map?.name || '',
    mapRaw: snap.map?.nameRaw || '',
    mode: '',
    // ID local deste PC — o GSI da Valve NÃO envia um match id comum à sala
    player: {
      name: snap.player?.name || '',
      steamid: snap.player?.steamid || '',
      team: snap.player?.team || '',
    },
    scoreCt: snap.map?.scoreCt || 0,
    scoreT: snap.map?.scoreT || 0,
    result: '',
    stats: {
      kills: snap.player?.kills || 0,
      assists: snap.player?.assists || 0,
      deaths: snap.player?.deaths || 0,
      mvps: snap.player?.mvps || 0,
      score: snap.player?.score || 0,
    },
    rounds: [],
    events: [],
    roster: [],
    hadAllplayers: false,
    correlationHint: null,
    _prev: {
      kills: snap.player?.kills || 0,
      assists: snap.player?.assists || 0,
      deaths: snap.player?.deaths || 0,
      mvps: snap.player?.mvps || 0,
      scoreCt: snap.map?.scoreCt || 0,
      scoreT: snap.map?.scoreT || 0,
      round: snap.map?.round || 0,
      phase: snap.map?.phase || '',
      roundPhase: snap.round?.phase || '',
      weapon: snap.player?.weapon || '',
    },
  };
  upsertLiveToStore(true);
}

function pushEvent(ev) {
  if (!live) return;
  live.events.push(ev);
  if (live.events.length > MAX_EVENTS) {
    live.events = live.events.slice(-MAX_EVENTS);
  }
}

function finalizeMatch(reason) {
  if (!live) return null;
  const now = Date.now();
  live.status = 'finished';
  live.endedAt = now;
  live.updatedAt = now;
  live.endReason = reason || 'unknown';
  live.durationSec = Math.max(0, Math.round((live.endedAt - live.startedAt) / 1000));

  const myTeam = String(live.player.team || '').toUpperCase();
  if (live.scoreCt !== live.scoreT && myTeam) {
    const ctWin = live.scoreCt > live.scoreT;
    if ((myTeam === 'CT' && ctWin) || (myTeam === 'T' && !ctWin)) live.result = 'win';
    else live.result = 'loss';
  } else if (live.scoreCt === live.scoreT && live.endReason === 'gameover') {
    live.result = 'draw';
  }

  const steamids = [...new Set((live.roster || []).map((p) => p.steamid).filter(Boolean))].sort();
  live.correlationHint = {
    mapRaw: live.mapRaw || live.map || '',
    startedBucket: Math.floor(live.startedAt / 60_000),
    steamids,
  };

  const saved = publicMatch(live);
  const store = readStore();
  store.matches = [saved, ...store.matches.filter((m) => m.id !== saved.id)].slice(0, MAX_MATCHES);
  writeStore(store);
  live = null;
  lastUpsertAt = 0;
  try {
    onMatchSaved(saved);
  } catch {
    /* ignore */
  }
  return saved;
}

function ingest(snap, rawBody) {
  if (!snap?.map) return { live: !!live };

  const phase = String(snap.map.phase || '');
  const mapRaw = snap.map.nameRaw || snap.map.name || '';
  const menuish = !mapRaw || phase === '' || phase === 'menu';

  if (menuish) {
    // Saiu para menu com partida a meio → grava o que houver
    if (live && Date.now() - (snap.at || Date.now()) < 5000) {
      /* keep waiting for more */
    }
    return { live: !!live, matchId: live?.id };
  }

  if (!live) {
    if (phase === 'live' || phase === 'warmup' || phase === 'intermission' || phase === 'gameover' || snap.map.round > 0) {
      startMatch(snap);
    } else {
      return { live: false };
    }
  }

  // Mudança de mapa a meio → fecha a anterior
  if (live.mapRaw && mapRaw && live.mapRaw !== mapRaw && phase !== 'gameover') {
    finalizeMatch('map_change');
    startMatch(snap);
  }

  const prev = live._prev;
  const at = snap.at || Date.now();

  live.map = snap.map.name || live.map;
  live.mapRaw = mapRaw || live.mapRaw;
  live.player.name = snap.player?.name || live.player.name;
  live.player.steamid = snap.player?.steamid || live.player.steamid;
  live.player.team = snap.player?.team || live.player.team;
  live.scoreCt = snap.map.scoreCt;
  live.scoreT = snap.map.scoreT;
  live.stats = {
    kills: snap.player.kills,
    assists: snap.player.assists,
    deaths: snap.player.deaths,
    mvps: snap.player.mvps,
    score: snap.player.score,
  };

  const selfRow = {
    name: snap.player?.name || live.player.name || '',
    steamid: snap.player?.steamid || live.player.steamid || '',
    team: snap.player?.team || live.player.team || '',
    kills: snap.player.kills,
    assists: snap.player.assists,
    deaths: snap.player.deaths,
    mvps: snap.player.mvps,
    score: snap.player.score,
    isSelf: true,
  };

  const roster = rosterFromAllplayers(rawBody?.allplayers).map((p) => ({
    ...p,
    isSelf:
      (!!selfRow.steamid && p.steamid === selfRow.steamid) ||
      (!!selfRow.name && p.name === selfRow.name),
  }));
  if (roster.length) {
    live.hadAllplayers = true;
    const withoutSelf = roster.filter((p) => !p.isSelf);
    live.roster = [selfRow, ...withoutSelf];
  } else {
    // Sem allplayers: pelo menos o teu nome + K/D
    const others = (live.roster || []).filter((p) => !p.isSelf);
    live.roster = [selfRow, ...others];
  }

  // Round terminou (placar mudou)
  if (snap.map.scoreCt !== prev.scoreCt || snap.map.scoreT !== prev.scoreT) {
    const winTeam =
      snap.round?.winTeam ||
      (snap.map.scoreCt > prev.scoreCt ? 'CT' : snap.map.scoreT > prev.scoreT ? 'T' : '');
    const roundRec = {
      at,
      round: snap.map.round,
      scoreCt: snap.map.scoreCt,
      scoreT: snap.map.scoreT,
      winTeam,
      bomb: snap.round?.bomb || '',
    };
    live.rounds.push(roundRec);
    pushEvent({ type: 'round_end', ...roundRec });
  }

  // Kills / assists / deaths / MVP (inferidos — GSI não manda kill-feed)
  const dk = snap.player.kills - prev.kills;
  if (dk > 0) {
    for (let i = 0; i < dk; i++) {
      pushEvent({
        type: 'kill',
        at,
        weapon: snap.player.weapon || prev.weapon || '',
        team: snap.player.team || '',
        scoreCt: snap.map.scoreCt,
        scoreT: snap.map.scoreT,
        round: snap.map.round,
        note: 'inferido (GSI não envia vítima em MM normal)',
      });
    }
  }
  const da = snap.player.assists - prev.assists;
  if (da > 0) {
    for (let i = 0; i < da; i++) {
      pushEvent({
        type: 'assist',
        at,
        weapon: snap.player.weapon || '',
        round: snap.map.round,
      });
    }
  }
  const dd = snap.player.deaths - prev.deaths;
  if (dd > 0) {
    for (let i = 0; i < dd; i++) {
      pushEvent({
        type: 'death',
        at,
        round: snap.map.round,
        scoreCt: snap.map.scoreCt,
        scoreT: snap.map.scoreT,
        note: 'inferido (GSI não envia killer em MM normal)',
      });
    }
  }
  if (snap.player.mvps > prev.mvps) {
    pushEvent({ type: 'mvp', at, mvps: snap.player.mvps, round: snap.map.round });
  }

  live._prev = {
    kills: snap.player.kills,
    assists: snap.player.assists,
    deaths: snap.player.deaths,
    mvps: snap.player.mvps,
    scoreCt: snap.map.scoreCt,
    scoreT: snap.map.scoreT,
    round: snap.map.round,
    phase,
    roundPhase: snap.round?.phase || '',
    weapon: snap.player.weapon || '',
  };

  const meaningful =
    dk > 0 ||
    da > 0 ||
    dd > 0 ||
    snap.map.scoreCt !== prev.scoreCt ||
    snap.map.scoreT !== prev.scoreT ||
    snap.player.mvps > prev.mvps;

  if (phase === 'gameover') {
    const saved = finalizeMatch('gameover');
    return { live: false, saved };
  }

  upsertLiveToStore(meaningful);
  return { live: true, matchId: live.id };
}

function flushOpenMatch(reason = 'app_stop') {
  if (!live) return null;
  return finalizeMatch(reason);
}

function liveMatchSummary() {
  if (!live) return null;
  return {
    id: live.id,
    startedAt: live.startedAt,
    map: live.map,
    scoreCt: live.scoreCt,
    scoreT: live.scoreT,
    stats: live.stats,
    eventsCount: live.events.length,
    hadAllplayers: live.hadAllplayers,
  };
}

module.exports = {
  configure,
  setMatchSavedHandler,
  listMatches,
  getMatch,
  clearMatches,
  mergeValveDetail,
  ingest,
  flushOpenMatch,
  liveMatchSummary,
};
