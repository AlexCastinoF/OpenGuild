/**
 * CS2 Game State Integration (GSI) — localhost HTTP + cfg na pasta do jogo.
 * Fase 1: só Electron local (sem API VPS).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dialog } = require('electron');
const history = require('./cs2-gsi-history');

const CFG_NAME = 'gamestate_integration_steamfarm.cfg';
const DEFAULT_PORT = 39281;

/** @type {import('http').Server | null} */
let server = null;
let listenPort = DEFAULT_PORT;
let authToken = '';
/** @type {(snap: object) => void} */
let onUpdate = () => {};
/** @type {object | null} */
let lastSnapshot = null;
let lastReceivedAt = 0;
let listening = false;
let lastError = '';

function setUpdateHandler(fn) {
  onUpdate = typeof fn === 'function' ? fn : () => {};
}

function randomToken() {
  return crypto.randomBytes(16).toString('hex');
}

function status() {
  return {
    ok: true,
    enabled: listening,
    listening,
    port: listenPort,
    authConfigured: !!authToken,
    cfgName: CFG_NAME,
    lastReceivedAt: lastReceivedAt || null,
    receiving: lastReceivedAt > 0 && Date.now() - lastReceivedAt < 15000,
    waiting: listening && !(lastReceivedAt > 0 && Date.now() - lastReceivedAt < 15000),
    error: lastError || '',
    snapshot: lastSnapshot,
    liveMatch: history.liveMatchSummary(),
  };
}

function getSnapshot() {
  return lastSnapshot;
}

/** Parse libraryfolders.vdf (simple key "path") */
function parseLibraryFolders(vdfText) {
  const paths = [];
  const re = /"path"\s+"([^"]+)"/gi;
  let m;
  while ((m = re.exec(vdfText))) {
    paths.push(m[1].replace(/\\\\/g, '\\'));
  }
  return paths;
}

function candidateSteamRoots() {
  const roots = [];
  const pf = process.env['ProgramFiles(x86)'] || process.env.ProgramFiles || 'C:\\Program Files (x86)';
  roots.push(path.join(pf, 'Steam'));
  if (process.env.ProgramFiles) {
    roots.push(path.join(process.env.ProgramFiles, 'Steam'));
  }
  const home = process.env.USERPROFILE || '';
  if (home) {
    roots.push(path.join(home, 'Steam'));
    roots.push(path.join(home, 'Games', 'Steam'));
  }
  // Dedup
  return [...new Set(roots.map((p) => path.normalize(p)))];
}

function findCs2CfgDir(customRoot, opts = {}) {
  const onlyCustom = !!opts.onlyCustom;
  const roots = [];
  if (customRoot) roots.push(String(customRoot));

  if (!onlyCustom) {
    for (const steamRoot of candidateSteamRoots()) {
      const libFile = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
      try {
        if (fs.existsSync(libFile)) {
          const libs = parseLibraryFolders(fs.readFileSync(libFile, 'utf8'));
          for (const lib of libs) roots.push(lib);
        }
      } catch {
        /* ignore */
      }
      roots.push(steamRoot);
    }
  }

  const seen = new Set();
  for (const root of roots) {
    const n = path.normalize(root);
    if (seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());

    const candidates = [
      // CS2 layout
      path.join(n, 'steamapps', 'common', 'Counter-Strike Global Offensive', 'game', 'csgo', 'cfg'),
      path.join(n, 'common', 'Counter-Strike Global Offensive', 'game', 'csgo', 'cfg'),
      // If user picked the cfg folder itself
      n.endsWith(`${path.sep}cfg`) || n.toLowerCase().endsWith(`${path.sep}cfg`) ? n : '',
      path.basename(n).toLowerCase() === 'cfg' ? n : '',
      // If user picked game/csgo
      path.join(n, 'cfg'),
      path.join(n, 'game', 'csgo', 'cfg'),
    ].filter(Boolean);

    for (const cfgDir of candidates) {
      try {
        if (fs.existsSync(cfgDir) && fs.statSync(cfgDir).isDirectory()) {
          return cfgDir;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function writeCfgFile(cfgDir, port, token) {
  const uri = `http://127.0.0.1:${port}/gsi`;
  const body = `"SteamFarmComunidade"
{
  "uri" "${uri}"
  "timeout" "5.0"
  "buffer" "0.1"
  "throttle" "0.1"
  "heartbeat" "5.0"
  "auth"
  {
    "token" "${token}"
  }
  "data"
  {
    "provider"            "1"
    "map"                 "1"
    "round"               "1"
    "player_id"           "1"
    "player_state"        "1"
    "player_weapons"      "1"
    "player_match_stats"  "1"
    "allplayers_id"       "1"
    "allplayers_state"    "1"
    "allplayers_match_stats" "1"
    "phase_countdowns"    "1"
    "bomb"                "1"
  }
}
`;
  const filePath = path.join(cfgDir, CFG_NAME);
  fs.writeFileSync(filePath, body, 'utf8');
  return filePath;
}

function removeCfgFile(cfgDir) {
  if (!cfgDir) return false;
  const filePath = path.join(cfgDir, CFG_NAME);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function pickActiveWeapon(weapons) {
  if (!weapons || typeof weapons !== 'object') return '';
  for (const w of Object.values(weapons)) {
    if (w && (w.state === 'active' || w.state === 'reloading')) {
      return String(w.name || w.type || '').replace(/^weapon_/, '');
    }
  }
  const first = Object.values(weapons)[0];
  return first ? String(first.name || '').replace(/^weapon_/, '') : '';
}

function normalizePayload(body) {
  const map = body.map || {};
  const player = body.player || {};
  const state = player.state || {};
  const matchStats = player.match_stats || {};
  const teamCt = map.team_ct || {};
  const teamT = map.team_t || {};
  const round = body.round || {};
  const provider = body.provider || {};
  const allplayers = body.allplayers;

  let roster = [];
  if (allplayers && typeof allplayers === 'object') {
    roster = Object.values(allplayers).map((p) => {
      const st = p?.match_stats || {};
      const state = p?.state || {};
      return {
        name: p?.name || '',
        steamid: p?.steamid || '',
        team: p?.team || '',
        health: Number(state.health) || 0,
        kills: Number(st.kills) || 0,
        assists: Number(st.assists) || 0,
        deaths: Number(st.deaths) || 0,
        mvps: Number(st.mvps) || 0,
      };
    });
  }

  return {
    at: Date.now(),
    provider: {
      name: provider.name || '',
      appid: provider.appid || null,
      steamid: provider.steamid || '',
      timestamp: provider.timestamp || null,
    },
    map: {
      name: String(map.name || '').replace(/^de_/, '') || map.name || '',
      nameRaw: map.name || '',
      phase: map.phase || '',
      round: Number(map.round) || 0,
      scoreCt: Number(teamCt.score) || 0,
      scoreT: Number(teamT.score) || 0,
      mode: map.mode || '',
    },
    round: {
      phase: round.phase || '',
      bomb: round.bomb || '',
      winTeam: round.win_team || '',
    },
    player: {
      name: player.name || '',
      steamid: player.steamid || '',
      team: player.team || '',
      activity: player.activity || '',
      health: Number(state.health) || 0,
      armor: Number(state.armor) || 0,
      helmet: !!state.helmet,
      money: Number(state.money) || 0,
      roundKills: Number(state.round_kills) || 0,
      roundKillHs: Number(state.round_killhs) || 0,
      equipValue: Number(state.equip_value) || 0,
      kills: Number(matchStats.kills) || 0,
      assists: Number(matchStats.assists) || 0,
      deaths: Number(matchStats.deaths) || 0,
      mvps: Number(matchStats.mvps) || 0,
      score: Number(matchStats.score) || 0,
      weapon: pickActiveWeapon(player.weapons),
    },
    bomb: body.bomb
      ? {
          state: body.bomb.state || '',
          countdown: body.bomb.countdown ?? null,
        }
      : null,
    phaseCountdowns: body.phase_countdowns
      ? {
          phase: body.phase_countdowns.phase || '',
          phaseEndsIn: body.phase_countdowns.phase_ends_in ?? null,
        }
      : null,
    allplayersCount: roster.length,
    roster,
  };
}

function startServer(port, token) {
  return new Promise((resolve, reject) => {
    stopServer();
    authToken = token;
    listenPort = port;
    lastError = '';

    const srv = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'steamfarm-gsi' }));
        return;
      }
      if (req.method !== 'POST' || !String(req.url || '').startsWith('/gsi')) {
        res.writeHead(404);
        res.end();
        return;
      }

      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          const body = JSON.parse(raw || '{}');
          const got = body?.auth?.token;
          if (authToken && got !== authToken) {
            res.writeHead(401);
            res.end('unauthorized');
            return;
          }
          lastSnapshot = normalizePayload(body);
          lastReceivedAt = Date.now();
          try {
            history.ingest(lastSnapshot, body);
          } catch {
            /* ignore */
          }
          try {
            onUpdate(lastSnapshot);
          } catch {
            /* ignore */
          }
          res.writeHead(200);
          res.end('ok');
        } catch (e) {
          lastError = e?.message || String(e);
          res.writeHead(400);
          res.end('bad json');
        }
      });
    });

    srv.on('error', (err) => {
      lastError = err?.message || String(err);
      listening = false;
      server = null;
      reject(err);
    });

    srv.listen(port, '127.0.0.1', () => {
      server = srv;
      listening = true;
      lastError = '';
      resolve({ port, token });
    });
  });
}

function stopServer() {
  try {
    history.flushOpenMatch('listener_stop');
  } catch {
    /* ignore */
  }
  if (server) {
    try {
      server.close();
    } catch {
      /* ignore */
    }
  }
  server = null;
  listening = false;
}

/**
 * @param {{
 *   loadSettings: () => object,
 *   saveSettings: (partial: object) => object,
 *   port?: number,
 *   pickFolder?: boolean,
 *   parentWindow?: Electron.BrowserWindow | null,
 * }} opts
 */
async function enable(opts) {
  const loadSettings = opts.loadSettings;
  const saveSettings = opts.saveSettings;
  const settings = loadSettings();
  let token = String(settings.cs2GsiToken || '').trim() || randomToken();
  const port = Number(opts.port) || Number(settings.cs2GsiPort) || DEFAULT_PORT;
  let cfgRoot = String(settings.cs2CfgDir || settings.cs2InstallHint || '').trim();

  let cfgDir = cfgRoot
    ? findCs2CfgDir(cfgRoot, { onlyCustom: true }) || findCs2CfgDir(cfgRoot)
    : findCs2CfgDir('');
  if (!cfgDir && opts.pickFolder !== false) {
    const win = opts.parentWindow || null;
    const picked = await dialog.showOpenDialog(win || undefined, {
      title: 'Selecione a pasta cfg do CS2 (…/game/csgo/cfg)',
      properties: ['openDirectory'],
    });
    if (picked.canceled || !picked.filePaths?.[0]) {
      return { ok: false, error: 'Pasta do CS2 não encontrada. Escolha …/game/csgo/cfg.' };
    }
    cfgDir = findCs2CfgDir(picked.filePaths[0]) || picked.filePaths[0];
  }
  if (!cfgDir) {
    return { ok: false, error: 'Pasta cfg do CS2 não encontrada.' };
  }

  try {
    await startServer(port, token);
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }

  let cfgPath = '';
  try {
    cfgPath = writeCfgFile(cfgDir, port, token);
  } catch (e) {
    stopServer();
    return { ok: false, error: `Falha ao escrever cfg: ${e?.message || e}` };
  }

  saveSettings({
    cs2GsiEnabled: true,
    cs2GsiToken: token,
    cs2GsiPort: port,
    cs2CfgDir: cfgDir,
    cs2CfgPath: cfgPath,
  });

  return {
    ok: true,
    ...status(),
    cfgDir,
    cfgPath,
  };
}

async function redeploy(opts) {
  const settings = opts.loadSettings();
  if (!settings.cs2GsiEnabled && !settings.cs2CfgDir) {
    return enable(opts);
  }
  return enable({ ...opts, pickFolder: !settings.cs2CfgDir });
}

function disable(opts) {
  const settings = opts.loadSettings();
  const cfgDir = String(settings.cs2CfgDir || '').trim();
  removeCfgFile(cfgDir);
  stopServer();
  lastSnapshot = null;
  lastReceivedAt = 0;
  opts.saveSettings({
    cs2GsiEnabled: false,
  });
  return { ok: true, ...status(), cfgDir };
}

/** Auto-start: ligado por omissão; `cs2GsiEnabled === false` desliga. */
async function restoreIfEnabled(opts) {
  const settings = opts.loadSettings();
  // Utilizador desactivou nas definições — não arrancar nem pedir pasta.
  if (settings.cs2GsiEnabled === false) {
    return { ok: true, skipped: true, disabled: true };
  }

  const token = String(settings.cs2GsiToken || '').trim() || randomToken();
  const port = Number(settings.cs2GsiPort) || DEFAULT_PORT;
  const hadCfg = !!String(settings.cs2CfgDir || '').trim();

  // Já configurado antes: listener + regrava cfg (heartbeat/token actualizados).
  if (settings.cs2GsiEnabled === true && hadCfg) {
    try {
      await startServer(port, token);
      try {
        const cfgPath = writeCfgFile(String(settings.cs2CfgDir), port, token);
        opts.saveSettings({
          cs2GsiToken: token,
          cs2GsiPort: port,
          cs2GsiEnabled: true,
          cs2CfgPath: cfgPath,
        });
      } catch {
        opts.saveSettings({ cs2GsiToken: token, cs2GsiPort: port, cs2GsiEnabled: true });
      }
      return { ok: true, ...status(), restored: true };
    } catch (e) {
      lastError = e?.message || String(e);
      return { ok: false, error: lastError };
    }
  }

  // Primeiro arranque / ainda sem flag: detectar Steam + escrever cfg (sem diálogo).
  const auto = await enable({
    ...opts,
    pickFolder: false,
    port,
  });
  if (auto.ok) return { ...auto, auto: true };

  // Pasta não encontrada — fica disponível nas definições (escolher pasta / reimplantar).
  lastError = auto.error || lastError;
  opts.saveSettings({
    cs2GsiEnabled: true,
    cs2GsiToken: token,
    cs2GsiPort: port,
  });
  return {
    ok: false,
    error: lastError || 'Pasta cfg do CS2 não encontrada.',
    needsFolder: true,
    auto: true,
  };
}

function detectCfgDir(customRoot) {
  return findCs2CfgDir(customRoot || '');
}

function configure(opts) {
  history.configure(opts || {});
}

function listHistory(limit) {
  return history.listMatches(limit);
}

function getHistoryMatch(id) {
  return history.getMatch(id);
}

function clearHistory() {
  return history.clearMatches();
}

function mergeHistoryValve(matchId, valve) {
  return history.mergeValveDetail(matchId, valve);
}

function setMatchSavedHandler(fn) {
  history.setMatchSavedHandler(fn);
}

module.exports = {
  CFG_NAME,
  DEFAULT_PORT,
  setUpdateHandler,
  setMatchSavedHandler,
  status,
  getSnapshot,
  enable,
  disable,
  redeploy,
  restoreIfEnabled,
  detectCfgDir,
  stopServer,
  configure,
  listHistory,
  getHistoryMatch,
  clearHistory,
  mergeHistoryValve,
};
