/**
 * CS2 private match: dedicated real (cs2.exe -dedicated) + client connect via Steam.
 * Times: plugin CounterStrikeSharp no dedicated (sf_pm_teams.json), não inject no cliente.
 */
const { execFile, spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const https = require('https');
const { clipboard, shell } = require('electron');
const matchServerMods = require('./match-server-mods');

let dedicatedChild = null;
let dedicatedMeta = null;
/** Reaplica round/freeze via stdin — competitive CS2 sobrescreve cvars. */
let adminReapplyTimer = null;

function stopAdminReapply() {
  if (adminReapplyTimer) {
    clearInterval(adminReapplyTimer);
    adminReapplyTimer = null;
  }
}

function startAdminReapply() {
  stopAdminReapply();
  adminReapplyTimer = setInterval(() => {
    if (!dedicatedChild || dedicatedChild.killed || dedicatedChild.exitCode != null) {
      stopAdminReapply();
      return;
    }
    const s = dedicatedMeta?.adminSettings;
    if (!s || typeof s !== 'object') return;
    // Tempos + economia (competitive reverte)
    const keys = [
      'mp_roundtime',
      'mp_freezetime',
      'mp_buytime',
      'cash_player_killed_enemy_default',
      'cash_team_winner_bonus',
      'cash_team_loser_bonus',
      'mp_afterroundmoney',
      'mp_startmoney',
      'mp_maxmoney',
      'mp_autokick',
    ];
    const slice = {};
    for (const k of keys) {
      if (s[k] != null) slice[k] = s[k];
    }
    // Sempre reaplicar: sem kick AFK em privada
    if (slice.mp_autokick == null) slice.mp_autokick = 0;
    if (Object.keys(slice).length === 0) return;
    const cmds = expandAdminCommands(slice);
    if (cmds.length) void dedicatedExecMany(cmds, { waitMs: 0 });
  }, 8000);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readRegSteamPath() {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err) return resolve('');
        const m = String(stdout).match(/SteamPath\s+REG_SZ\s+(.+)/i);
        resolve(m ? m[1].trim().replace(/\//g, '\\') : '');
      },
    );
  });
}

function parseLibraryFolders(vdfText) {
  const paths = [];
  const re = /"path"\s+"([^"]+)"/gi;
  let m;
  while ((m = re.exec(vdfText))) {
    paths.push(m[1].replace(/\\\\/g, '\\'));
  }
  return paths;
}

async function resolveSteamExe() {
  const fromReg = await readRegSteamPath();
  const candidates = [
    fromReg ? path.join(fromReg, 'steam.exe') : '',
    path.join(process.env['ProgramFiles(x86)'] || '', 'Steam', 'steam.exe'),
    path.join(process.env.ProgramFiles || '', 'Steam', 'steam.exe'),
    'C:\\Program Files (x86)\\Steam\\steam.exe',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return '';
}

async function resolveCs2Paths() {
  const steamRoot = await readRegSteamPath();
  const libs = [];
  if (steamRoot) {
    libs.push(steamRoot);
    try {
      const vdf = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
      if (fs.existsSync(vdf)) {
        libs.push(...parseLibraryFolders(fs.readFileSync(vdf, 'utf8')));
      }
    } catch {
      /* ignore */
    }
  }
  libs.push(
    'C:\\Program Files (x86)\\Steam',
    'H:\\SteamLibrary',
    'S:\\SteamLibrary',
    'W:\\SteamLibrary',
  );

  const seen = new Set();
  for (const lib of libs) {
    const root = String(lib || '').trim();
    if (!root || seen.has(root.toLowerCase())) continue;
    seen.add(root.toLowerCase());
    const exe = path.join(
      root,
      'steamapps',
      'common',
      'Counter-Strike Global Offensive',
      'game',
      'bin',
      'win64',
      'cs2.exe',
    );
    if (fs.existsSync(exe)) {
      const gameRoot = path.join(
        root,
        'steamapps',
        'common',
        'Counter-Strike Global Offensive',
        'game',
      );
      const cfgDir = path.join(gameRoot, 'csgo', 'cfg');
      return { exe, gameRoot, cfgDir, steamRoot: root };
    }
  }
  return { exe: '', gameRoot: '', cfgDir: '', steamRoot: steamRoot || '' };
}

function isVirtualIface(name) {
  return /virtual|vmware|vbox|hyper-v|vethernet|wsl|docker|hamachi|loopback|bluetooth|tap-|tun|zerotier/i.test(
    String(name || ''),
  );
}

function lanIpv4() {
  try {
    const nets = os.networkInterfaces();
    const scored = [];
    for (const [name, list] of Object.entries(nets || {})) {
      for (const n of list || []) {
        const family = n.family === 'IPv4' || n.family === 4;
        if (!family || n.internal) continue;
        const addr = String(n.address || '');
        if (!addr || addr.startsWith('127.') || addr.startsWith('169.254.')) continue;
        let score = 10;
        if (isVirtualIface(name)) score -= 8;
        if (addr.startsWith('192.168.')) score += 5;
        else if (addr.startsWith('10.')) score += 3;
        scored.push({ addr, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored[0]?.addr) return scored[0].addr;
  } catch {
    /* ignore */
  }
  return '127.0.0.1';
}

function allowUdpFirewall(port) {
  return new Promise((resolve) => {
    execFile(
      'netsh',
      [
        'advfirewall',
        'firewall',
        'add',
        'rule',
        `name=SteamFarm CS2 UDP ${port}`,
        'dir=in',
        'action=allow',
        'protocol=UDP',
        `localport=${String(port)}`,
        'profile=any',
      ],
      { windowsHide: true, timeout: 8000 },
      () => resolve(),
    );
  });
}

function isPrivateIpv4(ip) {
  const s = String(ip || '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return true;
  if (s.startsWith('10.') || s.startsWith('127.') || s.startsWith('192.168.') || s.startsWith('169.254.')) {
    return true;
  }
  const m = s.match(/^172\.(\d+)\./);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return true;
  }
  return false;
}

function httpsGetText(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { timeout: timeoutMs, headers: { 'User-Agent': 'SteamFarm-Comunidade' } },
      (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          httpsGetText(res.headers.location, timeoutMs).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

/** IPv4 visto pela internet — o que os convidados precisam no steam://connect. */
async function fetchPublicIpv4(timeoutMs = 4000) {
  const urls = ['https://api.ipify.org', 'https://ipv4.icanhazip.com', 'https://ifconfig.me/ip'];
  for (const url of urls) {
    try {
      const raw = String(await httpsGetText(url, timeoutMs) || '').trim();
      if (!isPrivateIpv4(raw)) return raw;
    } catch {
      /* next */
    }
  }
  return '';
}

function mapWorkshopName(mapId) {
  const id = String(mapId || 'mirage').toLowerCase().replace(/^de_/, '');
  return `de_${id}`;
}

function runSteamUri(uri) {
  return new Promise((resolve) => {
    try {
      shell.openExternal(uri).then(
        () => resolve({ ok: true, via: 'shell' }),
        () => resolve({ ok: false, via: 'shell' }),
      );
    } catch {
      resolve({ ok: false, via: 'shell' });
    }
  });
}

function launchSteamArgs(steamExe, args) {
  return new Promise((resolve) => {
    if (!steamExe) return resolve({ ok: false, via: 'none' });
    try {
      const child = spawn(steamExe, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      resolve({ ok: true, via: 'steam-exe' });
    } catch {
      resolve({ ok: false, via: 'steam-exe' });
    }
  });
}

function isPortOpen(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.setTimeout(timeoutMs);
    sock.on('timeout', () => {
      sock.destroy();
      resolve(false);
    });
    sock.on('error', () => resolve(false));
  });
}

async function waitForPort(host, port, timeoutMs, onTick) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (onTick) onTick(Date.now() - start);
    if (await isPortOpen(host, port, 600)) return true;
    await sleep(750);
  }
  return false;
}

function isUdpPortBound(port) {
  return new Promise((resolve) => {
    exec(
      `netstat -ano -p udp | findstr ":${port}"`,
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(false);
        resolve(/UDP/i.test(String(stdout || '')) && String(stdout).includes(`:${port}`));
      },
    );
  });
}

/** Primeira porta UDP livre em [from,to] (evita conflito entre dedicados). */
async function pickFreeUdpPort(from = 27015, to = 27030) {
  const a = Math.min(from, to);
  const b = Math.max(from, to);
  for (let p = a; p <= b; p += 1) {
    if (!(await isUdpPortBound(p))) return p;
  }
  return 0;
}

function looksDedicatedReady(logBuf) {
  const t = String(logBuf || '');
  return (
    /Server is hibernating/i.test(t) ||
    /VAC secure mode/i.test(t) ||
    /Game server logged in/i.test(t) ||
    /SV:\s+Spawn Server/i.test(t) ||
    /CNetworkGameServerBase::SetServerState \(ss_loading -> ss_active\)/i.test(t) ||
    /server started/i.test(t)
  );
}

function summarizeDedicatedFailure(logBuf) {
  const t = String(logBuf || '');
  const fatal = t.match(/FATAL ERROR:\s*(.+)/i);
  if (fatal) return fatal[1].trim().slice(0, 220);
  if (/unable to load gameinfo\.gi/i.test(t)) {
    return 'Dedicated não encontrou gameinfo.gi no overlay (paths CS2 incompletos).';
  }
  if (/csgo_imported/i.test(t) && /Can't find/i.test(t)) {
    return 'Falta csgo_imported no overlay — junctions do game/ incompletas.';
  }
  if (/invalid.*login.*token|Gameserver.*login.*token|SteamGameServer_Init failed/i.test(t)) {
    return 'Steam rejeitou o GSLT. Regenera token App ID 730.';
  }
  const tail = t.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' · ');
  return tail ? tail.slice(0, 220) : 'Dedicated encerrou sem mensagem clara no log.';
}

async function waitForDedicatedReady(port, timeoutMs, getLog, isAlive, onTick) {
  const start = Date.now();
  let sawLog = false;
  let sawUdp = false;
  let lastProgressAt = 0;
  while (Date.now() - start < timeoutMs) {
    if (typeof isAlive === 'function' && !isAlive()) {
      return {
        ok: false,
        via: 'exited',
        confirmed: false,
        earlyExit: true,
        sawUdp,
        sawLog,
      };
    }
    const log = getLog();
    if (looksDedicatedReady(log)) sawLog = true;
    if (await isUdpPortBound(port)) sawUdp = true;
    if (sawLog && sawUdp) return { ok: true, via: 'log+udp', confirmed: true };
    const elapsed = Date.now() - start;
    if (typeof onTick === 'function' && elapsed - lastProgressAt >= 4000) {
      lastProgressAt = elapsed;
      onTick({
        elapsedSec: Math.floor(elapsed / 1000),
        sawLog,
        sawUdp,
      });
    }
    await sleep(1000);
  }
  if (sawUdp && sawLog) return { ok: true, via: 'log+udp', confirmed: true };
  if (sawUdp) return { ok: false, via: 'udp-only', confirmed: false, sawUdp, sawLog };
  return { ok: false, via: 'none', confirmed: false, sawUdp, sawLog };
}

function isCs2ClientRunning() {
  return new Promise((resolve) => {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='cs2.exe'" | Where-Object { $_.CommandLine -notmatch '-dedicated' } | Select-Object -First 1 -ExpandProperty ProcessId`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', ps],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err) return resolve(false);
        resolve(/\d+/.test(String(stdout || '')));
      },
    );
  });
}

function buildConnectCmd(host, port, password) {
  const pw = String(password || '').trim();
  return pw
    ? `password ${pw}; connect ${host}:${port}`
    : `connect ${host}:${port}`;
}

function ensureCfgDir(cfgDir) {
  if (!cfgDir) return false;
  try {
    fs.mkdirSync(cfgDir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** Pastas cfg onde o CS2 aceita `exec` (jogo + userdata Steam). */
function listCs2CfgDirs(paths) {
  const dirs = [];
  if (paths?.cfgDir) dirs.push(paths.cfgDir);
  const steamRoot = paths?.steamRoot || '';
  if (steamRoot) {
    try {
      const ud = path.join(steamRoot, 'userdata');
      if (fs.existsSync(ud)) {
        for (const ent of fs.readdirSync(ud, { withFileTypes: true })) {
          if (!ent.isDirectory()) continue;
          const cfg = path.join(ud, ent.name, '730', 'local', 'cfg');
          if (fs.existsSync(path.dirname(cfg))) dirs.push(cfg);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return [...new Set(dirs)];
}

/** CS2: F1–F12 muitas vezes não disparam binds (UI/overlay). Usar tecla P = scancode19. */
function ensurePmBinds(cfgDir) {
  if (!ensureCfgDir(cfgDir)) return { ok: false };
  const bindsPath = path.join(cfgDir, 'sf_pm_binds.cfg');
  const connectPath = path.join(cfgDir, 'sf_pm_connect.cfg');
  try {
    fs.writeFileSync(
      bindsPath,
      [
        '// SteamFarm — P (scancode19); F8/F13 falham no menu CS2',
        'bind scancode19 "exec sf_pm_connect"',
        'bind scancode104 "exec sf_pm_connect"',
        '',
      ].join('\n'),
      'utf8',
    );
    if (!fs.existsSync(connectPath)) {
      fs.writeFileSync(connectPath, '// waiting\n', 'utf8');
    }
    try {
      const keysPath = path.join(cfgDir, 'cs2_user_keys_0_slot0.vcfg');
      if (cfgDir.includes(`${path.sep}730${path.sep}local${path.sep}cfg`)) {
        const raw =
          '"config"\n{\n\t"bindings"\n\t{\n' +
          '\t\t"scancode19"\t\t"exec sf_pm_connect"\n' +
          '\t\t"scancode104"\t\t"exec sf_pm_connect"\n' +
          '\t}\n}\n';
        fs.writeFileSync(keysPath, raw, 'utf8');
      }
    } catch {
      /* ignore */
    }
    const autoexec = path.join(cfgDir, 'autoexec.cfg');
    let auto = '';
    try {
      if (fs.existsSync(autoexec)) auto = fs.readFileSync(autoexec, 'utf8');
    } catch {
      auto = '';
    }
    if (!/exec\s+sf_pm_binds/i.test(auto)) {
      auto = `${auto.trimEnd()}\n\nexec sf_pm_binds\n`;
      fs.writeFileSync(autoexec, auto, 'utf8');
    }
    return { ok: true, bindsPath, connectPath, autoexec };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function writeConnectCfg(cfgDir, connectCmd) {
  if (!ensureCfgDir(cfgDir)) return false;
  try {
    fs.writeFileSync(
      path.join(cfgDir, 'sf_pm_connect.cfg'),
      [`echo SF-PM-CONNECT`, String(connectCmd).trim(), ''].join('\n'),
      'utf8',
    );
    return true;
  } catch {
    return false;
  }
}

function writeConnectCfgAll(paths, connectCmd) {
  const dirs = listCs2CfgDirs(paths);
  let n = 0;
  for (const d of dirs) {
    if (writeConnectCfg(d, connectCmd)) n += 1;
  }
  return { ok: n > 0, dirs: n };
}

/**
 * Binds no CS2 do user não disparam — só consola.
 * Auto: foca CS2 → tecla consola → cola `exec sf_pm_connect` → Enter.
 */
function forceInGameConnect(connectCmd, opts = {}) {
  const consoleVk = Number(opts?.consoleVk) > 0 ? Number(opts.consoleVk) : 0;
  const scriptPath = path.join(__dirname, 'match-inject.ps1');
  const extra = String(connectCmd || '').trim();
  return new Promise((resolve) => {
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-ConsoleVk',
      String(consoleVk),
    ];
    if (extra) {
      args.push('-ExtraCmd', extra);
    }
    execFile(
      'powershell.exe',
      args,
      { windowsHide: true, timeout: 60000 },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        resolve({
          ok: !err && out.includes('ok'),
          detail: out || String(stderr || '') || (err && err.message) || '',
          method: 'console-paste',
        });
      },
    );
  });
}

/** @deprecated */
function sendF13ToCs2() {
  return forceInGameConnect('');
}

async function stopDedicated() {
  stopAdminReapply();
  const child = dedicatedChild;
  dedicatedChild = null;
  const hadMeta = !!dedicatedMeta;
  dedicatedMeta = null;
  if (child && !child.killed) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    await sleep(400);
    try {
      if (child.pid) {
        exec(`taskkill /PID ${child.pid} /T /F`, { windowsHide: true });
      }
    } catch {
      /* ignore */
    }
  }
  // Garante limpeza se o PID ficou órfão
  try {
    exec(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='cs2.exe'\\" | Where-Object { $_.CommandLine -match '-dedicated' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { windowsHide: true },
    );
  } catch {
    /* ignore */
  }
  return { ok: true, stopped: hadMeta || !!child };
}

function dedicatedLogPath(userDataPath) {
  const dir = userDataPath || os.tmpdir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return path.join(dir, 'sf-cs2-dedicated.log');
}

function readLogFile(logPath) {
  try {
    return fs.readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

function resolveGslt(opts) {
  const fromOpts = String(opts?.gslt || '').trim();
  if (fromOpts) return fromOpts;
  const fromEnv = String(process.env.SF_CS2_GSLT || process.env.CS2_GSLT || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const p = String(opts?.gsltPath || '').trim();
    if (p && fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  } catch {
    /* ignore */
  }
  return '';
}

function numOr(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** Se max ≤ start, kill/win cash nunca sobem a conta. Floor 65k (competitive=16k). */
function resolveMaxMoney(start, maxRaw) {
  const s = Number(start);
  let m = maxRaw != null && maxRaw !== '' ? Number(maxRaw) : 65000;
  if (!Number.isFinite(m)) m = 65000;
  if (m < 65000) m = 65000;
  if (Number.isFinite(s)) {
    if (m < s) m = s;
    if (m <= s) m = Math.max(65000, s + 16000);
  }
  return m;
}

/**
 * Cvars do wizard/admin → linhas de cfg / stdin.
 * Competitive CS2 ignora só mp_roundtime — precisa mp_roundtime_defuse.
 */
function expandAdminCommands(settings, { asCfg = false } = {}) {
  if (!settings || typeof settings !== 'object') return [];
  const out = [];
  const push = (line) => {
    if (!line) return;
    out.push(asCfg ? line : line);
  };
  const n = (k, def) => {
    if (settings[k] == null) return def;
    return numOr(settings[k], def);
  };
  const set = (key, val) => {
    if (val == null || !Number.isFinite(Number(val))) return;
    push(`${key} ${Number(val)}`);
  };

  // Tempo
  if (settings.mp_roundtime != null) {
    const rt = n('mp_roundtime', 1.92);
    set('mp_roundtime', rt);
    set('mp_roundtime_defuse', rt);
    set('mp_roundtime_hostage', rt);
  }
  if (settings.mp_freezetime != null) set('mp_freezetime', n('mp_freezetime', 15));
  if (settings.mp_buytime != null) set('mp_buytime', n('mp_buytime', 20));
  if (settings.mp_warmuptime != null) {
    const w = n('mp_warmuptime', 0);
    set('mp_warmuptime', w);
    push(w > 0 ? 'mp_do_warmup_period 1' : 'mp_do_warmup_period 0');
  }
  if (settings.mp_halftime_duration != null) set('mp_halftime_duration', n('mp_halftime_duration', 15));
  if (settings.mp_team_intro_time != null) set('mp_team_intro_time', n('mp_team_intro_time', 0));

  // Economia
  if (settings.mp_startmoney != null) {
    const start = n('mp_startmoney', 800);
    set('mp_startmoney', start);
    set('mp_maxmoney', resolveMaxMoney(start, settings.mp_maxmoney));
  } else if (settings.mp_maxmoney != null) {
    set('mp_maxmoney', n('mp_maxmoney', 64000));
  }
  if (settings.cash_player_killed_enemy_default != null) {
    set('cash_player_killed_enemy_default', n('cash_player_killed_enemy_default', 300));
    set('mp_teamcashawards', 1);
    set('mp_playercashawards', 1);
  }
  // CS2 NÃO tem cash_team_winner_bonus — usa cvars de vitória reais
  if (settings.cash_team_winner_bonus != null) {
    const w = n('cash_team_winner_bonus', 3250);
    set('cash_team_elimination_bomb_map', w);
    set('cash_team_terrorist_win_bomb', w);
    set('cash_team_win_by_defusing_bomb', w);
    set('cash_team_win_by_time_running_out_bomb', w);
    set('cash_team_elimination_hostage_map_ct', w);
    set('cash_team_elimination_hostage_map_t', w);
    set('cash_team_win_by_hostage_rescue', w);
    set('cash_team_win_by_time_running_out_hostage', w);
    set('mp_teamcashawards', 1);
    set('mp_playercashawards', 1);
  }
  if (settings.cash_team_loser_bonus != null) {
    set('cash_team_loser_bonus', n('cash_team_loser_bonus', 1400));
    set('cash_team_loser_bonus_consecutive_rounds', n('cash_team_loser_bonus', 1400));
    set('mp_teamcashawards', 1);
  }
  if (settings.mp_afterroundmoney != null) set('mp_afterroundmoney', n('mp_afterroundmoney', 0));

  // Times
  if (settings.mp_limitteams != null) set('mp_limitteams', n('mp_limitteams', 0));
  if (settings.mp_spectators != null) set('mp_spectators', n('mp_spectators', 1));
  if (settings.mp_autoteambalance != null) set('mp_autoteambalance', n('mp_autoteambalance', 0));
  if (settings.bot_quota != null) {
    const q = n('bot_quota', 0);
    set('bot_quota', q);
    if (q > 0) {
      set('bot_difficulty', n('bot_difficulty', 1));
      set('bot_join_after_player', 0);
      set('bot_auto_vacate', 0);
      set('bot_stop', 0);
      push('bot_quota_mode normal');
      set('custom_bot_difficulty', n('bot_difficulty', 1));
    } else {
      push('bot_kick');
    }
  }

  // Partida
  if (settings.mp_maxrounds != null) set('mp_maxrounds', n('mp_maxrounds', 24));
  if (settings.mp_overtime_enable != null) set('mp_overtime_enable', n('mp_overtime_enable', 1));
  if (settings.mp_overtime_maxrounds != null) {
    set('mp_overtime_maxrounds', n('mp_overtime_maxrounds', 6));
  }
  if (settings.mp_overtime_startmoney != null) {
    set('mp_overtime_startmoney', n('mp_overtime_startmoney', 10000));
  }
  if (settings.mp_match_can_clinch != null) set('mp_match_can_clinch', n('mp_match_can_clinch', 1));
  if (settings.mp_halftime != null) set('mp_halftime', n('mp_halftime', 1));

  // Kick AFK / team damage (0 = off nas partidas privadas)
  if (settings.mp_autokick != null) set('mp_autokick', n('mp_autokick', 0));
  else set('mp_autokick', 0);

  // Combate
  if (settings.mp_friendlyfire != null) set('mp_friendlyfire', n('mp_friendlyfire', 0));
  if (settings.mp_tkpunish != null) set('mp_tkpunish', n('mp_tkpunish', 0));
  if (settings.mp_solid_teammates != null) set('mp_solid_teammates', n('mp_solid_teammates', 1));
  if (settings.mp_free_armor != null) set('mp_free_armor', n('mp_free_armor', 0));
  if (settings.mp_death_drop_gun != null) set('mp_death_drop_gun', n('mp_death_drop_gun', 1));
  if (settings.sv_cheats != null) set('sv_cheats', n('sv_cheats', 0));

  if (settings.restart) push('mp_restartgame 1');
  return out;
}

function adminSettingsCfgLines(settings) {
  return expandAdminCommands(settings, { asCfg: true });
}

function writeServerCfg(cfgDir, { password, gslt, hostname, cheats, adminSettings, soundSettings }) {
  if (!ensureCfgDir(cfgDir)) return '';
  const cfgPath = path.join(cfgDir, 'sf_pm_server.cfg');
  const admin = adminSettings || {};
  const limit =
    admin.mp_limitteams != null ? numOr(admin.mp_limitteams, 0) : 0;
  const specs =
    admin.mp_spectators != null ? numOr(admin.mp_spectators, 1) : 1;
  const adminLines = adminSettingsCfgLines(admin).filter(
    (l) => !l.startsWith('mp_limitteams ') && !l.startsWith('mp_spectators '),
  );
  const soundsOn = !!(soundSettings && soundSettings.enabled);
  const workshopIds = Array.isArray(soundSettings?.workshopIds)
    ? soundSettings.workshopIds.map((x) => String(x || '').trim()).filter(Boolean)
    : ['3461824328'];
  // Sem soundSettings (ex. applyAdmin) não apagar mm_extra_addons já escrito.
  const mamLines = !soundSettings
    ? []
    : soundsOn
      ? [
          `mm_extra_addons "${workshopIds.join(',') || '3461824328'}"`,
          'mm_block_disconnect_messages 1',
          'mm_cache_clients_with_addons 1',
        ]
      : ['// kill-sounds off'];
  const lines = [
    '// SteamFarm private-match dedicated',
    `hostname "${hostname || 'SF-Private-Match'}"`,
    'sv_lan 0',
    `sv_cheats ${cheats ? '1' : '0'}`,
    password ? `sv_password "${password}"` : 'sv_password ""',
    gslt ? `sv_setsteamaccount "${gslt}"` : '// missing GSLT',
    'mp_autoteambalance 0',
    `mp_limitteams ${limit}`,
    `mp_spectators ${specs}`,
    // Partidas privadas: sem kick por AFK / team damage
    'mp_autokick 0',
    ...adminLines,
    ...mamLines,
    '',
  ];
  const body = lines.join('\n');
  fs.writeFileSync(cfgPath, body, 'utf8');

  // Competitive carrega gamemode_competitive_server.cfg DEPOIS do server.cfg —
  // sem isto roundtime/freeze/cash são sobrescritos pelos defaults Valve.
  const compBody = [
    '// SteamFarm — overrides competitive (gerado)',
    ...adminLines,
    `mp_limitteams ${limit}`,
    `mp_spectators ${specs}`,
    'mp_autoteambalance 0',
    'mp_autokick 0',
    ...mamLines,
    '',
  ].join('\n');
  const compPath = path.join(cfgDir, 'gamemode_competitive_server.cfg');
  try {
    fs.writeFileSync(compPath, compBody, 'utf8');
  } catch {
    /* ignore */
  }

  try {
    const gameRoot = path.dirname(path.dirname(cfgDir));
    if (path.basename(path.dirname(cfgDir)) === 'csgo') {
      const alt = path.join(gameRoot, 'cfg');
      fs.mkdirSync(alt, { recursive: true });
      fs.writeFileSync(path.join(alt, 'sf_pm_server.cfg'), body, 'utf8');
      fs.writeFileSync(path.join(alt, 'gamemode_competitive_server.cfg'), compBody, 'utf8');
      if (soundsOn) {
        try {
          matchServerMods.writeMultiAddonManagerCfg(path.dirname(cfgDir), workshopIds);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return cfgPath;
}

/**
 * Host: dedicated REAL (cs2.exe -dedicated).
 * Porta: se opts.port <= 0, escolhe UDP livre 27015–27030.
 */
async function prepareHostListen(opts) {
  const progress = (phase, message, extra = {}) => {
    try {
      opts?.onProgress?.({ phase, message, ...extra });
    } catch {
      /* ignore */
    }
  };

  const password = String(opts?.password || '').trim() || 'rally';
  const map = mapWorkshopName(opts?.map || 'mirage');
  let port = Number(opts?.port) > 0 ? Number(opts.port) : 0;
  const lanHost = lanIpv4();
  let host = lanHost;
  let publicHost = '';
  const gslt = resolveGslt(opts);
  const logPath = dedicatedLogPath(opts?.userDataPath);
  const hostname = String(opts?.hostname || `SF-PM-${map}`).trim().slice(0, 48) || `SF-PM-${map}`;
  const cheats = !!opts?.cheats;

  progress('locate_cs2', 'A localizar instalação Steam do CS2…');
  const steamPaths = await resolveCs2Paths();
  if (!steamPaths.exe || !steamPaths.gameRoot) {
    return {
      ok: false,
      phase: 'failed',
      error: 'cs2_not_found',
      message:
        'cs2.exe não encontrado. Instala CS2 via Steam nesta máquina (host).',
      host,
      port,
      password,
      map,
    };
  }

  if (!opts?.userDataPath) {
    return {
      ok: false,
      phase: 'failed',
      error: 'no_userdata',
      message: 'userData em falta para o overlay CS2.',
      host,
      port,
      password,
      map,
    };
  }

  progress('overlay', 'A montar overlay (junctions + gameinfo local)…');
  const overlay = matchServerMods.ensureCs2Overlay(opts.userDataPath, steamPaths.gameRoot);
  if (!overlay.ok) {
    return {
      ok: false,
      phase: 'failed',
      error: 'overlay_failed',
      message: `Falha ao criar overlay CS2: ${overlay.error || 'unknown'}`,
      host,
      port,
      password,
      map,
      cs2Path: steamPaths.exe,
    };
  }

  const paths = {
    exe: overlay.exe || steamPaths.exe,
    gameRoot: overlay.gameRoot,
    cfgDir: overlay.cfgDir,
    steamGameRoot: steamPaths.gameRoot,
  };

  if (!gslt) {
    return {
      ok: false,
      phase: 'failed',
      error: 'needs_gslt',
      message:
        'Falta o GSLT (token de Game Server). Cria em steamcommunity.com/dev/managegameservers (App ID 730) e cola no lobby.',
      host,
      port,
      password,
      map,
      needsGslt: true,
      gsltUrl: 'https://steamcommunity.com/dev/managegameservers',
    };
  }

  progress('cleanup', 'A parar dedicated anterior (se existir)…');
  await stopDedicated();
  await sleep(800);

  if (!port) {
    progress('port', 'A escolher porta UDP livre (27015–27030)…');
    port = await pickFreeUdpPort(27015, 27030);
    if (!port) {
      return {
        ok: false,
        phase: 'failed',
        error: 'no_free_port',
        message: 'Nenhuma porta UDP livre entre 27015 e 27030.',
        host,
        port: 0,
        password,
        map,
        cs2Path: paths.exe,
      };
    }
  }

  if (await isUdpPortBound(port)) {
    const alt = await pickFreeUdpPort(27015, 27030);
    if (!alt || alt === port) {
      return {
        ok: false,
        phase: 'failed',
        error: 'port_busy',
        message: `Porta UDP ${port} já em uso. Fecha outro server CS2.`,
        host,
        port,
        password,
        map,
        cs2Path: paths.exe,
      };
    }
    port = alt;
  }

  progress('cfg', `A escrever cfg/teams · mapa ${map} · porta ${port}…`);
  ensurePmBinds(paths.cfgDir);
  writeServerCfg(paths.cfgDir, {
    password,
    gslt,
    hostname,
    cheats,
    adminSettings: opts?.adminSettings || null,
    soundSettings:
      opts?.soundSettings && typeof opts.soundSettings === 'object'
        ? opts.soundSettings
        : null,
  });
  matchServerMods.writeTeamsFile(paths.cfgDir, opts?.players || []);
  matchServerMods.writeAdminFile(
    paths.cfgDir,
    opts?.adminSettings || {},
    opts?.welcomeMessage || '',
    opts?.welcomeColor || 'green',
  );
  const soundSettings =
    opts?.soundSettings && typeof opts.soundSettings === 'object'
      ? opts.soundSettings
      : matchServerMods.defaultKillSoundsSettings();
  matchServerMods.writeSoundsFile(paths.cfgDir, soundSettings);

  progress('mods', 'A garantir Metamod / CounterStrikeSharp / plugin de times…');
  let mods = { ok: false };
  try {
    mods = await matchServerMods.ensureServerMods(
      paths.gameRoot,
      opts?.userDataPath ? path.join(opts.userDataPath, 'cs2-mods') : '',
      opts?.userDataPath || '',
    );
  } catch (e) {
    mods = { ok: false, error: e?.message || String(e) };
  }
  // Depois dos mods: regrava sons + MAM (dlls/cfg prontos)
  try {
    matchServerMods.writeSoundsFile(paths.cfgDir, soundSettings);
  } catch {
    /* ignore */
  }

  try {
    fs.writeFileSync(path.join(path.dirname(paths.exe), 'steam_appid.txt'), '730\n', 'utf8');
  } catch {
    /* ignore */
  }

  try {
    fs.writeFileSync(
      logPath,
      `[SF] starting dedicated (overlay) ${new Date().toISOString()}\n` +
        `[SF] overlay=${paths.gameRoot}\n` +
        `[SF] steam_gameinfo_bytes=${overlay.steamGameinfoBytes || '?'}\n` +
        `[SF] map=${map} port=${port} mods=${mods.ok ? 'ok' : mods.error || 'fail'}\n`,
      'utf8',
    );
  } catch {
    /* ignore */
  }

  const admin = opts.adminSettings && typeof opts.adminSettings === 'object' ? opts.adminSettings : {};
  const launchMoney = [];
  const pushPlus = (key, val) => {
    if (val == null || val === '') return;
    const n = Number(val);
    if (!Number.isFinite(n)) return;
    launchMoney.push(`+${key}`, String(n));
  };
  if (admin.mp_startmoney != null) {
    const start = numOr(admin.mp_startmoney, 800);
    pushPlus('mp_startmoney', start);
    pushPlus('mp_maxmoney', resolveMaxMoney(start, admin.mp_maxmoney));
  } else if (admin.mp_maxmoney != null) {
    pushPlus('mp_maxmoney', admin.mp_maxmoney);
  }
  pushPlus('cash_player_killed_enemy_default', admin.cash_player_killed_enemy_default);
  if (admin.cash_team_winner_bonus != null) {
    const w = numOr(admin.cash_team_winner_bonus, 3250);
    pushPlus('cash_team_elimination_bomb_map', w);
    pushPlus('cash_team_terrorist_win_bomb', w);
    pushPlus('cash_team_win_by_defusing_bomb', w);
    pushPlus('cash_team_win_by_time_running_out_bomb', w);
  }
  pushPlus('cash_team_loser_bonus', admin.cash_team_loser_bonus);
  pushPlus('mp_freezetime', admin.mp_freezetime);
  pushPlus('mp_roundtime_defuse', admin.mp_roundtime);

  const args = [
    '-dedicated',
    '-console',
    '-usercon',
    '-insecure',
    '-port',
    String(port),
    '+sv_lan',
    '0',
    '+sv_cheats',
    cheats ? '1' : '0',
    '+game_type',
    '0',
    '+game_mode',
    '1',
    '+map',
    map,
    '+sv_password',
    password,
    '+sv_setsteamaccount',
    gslt,
    '+hostname',
    hostname,
    ...launchMoney,
    '+mp_teamcashawards',
    '1',
    '+mp_playercashawards',
    '1',
    '+exec',
    'sf_pm_server',
    '+mp_autoteambalance',
    '0',
    '+mp_limitteams',
    '0',
  ];

  progress('spawn', `A lançar cs2.exe -dedicated (porta ${port})…`);
  let outFd;
  try {
    outFd = fs.openSync(logPath, 'a');
    dedicatedChild = spawn(paths.exe, args, {
      cwd: path.dirname(paths.exe),
      detached: false,
      windowsHide: true,
      stdio: ['pipe', outFd, outFd],
      env: {
        ...process.env,
        SteamAppId: '730',
        SteamGameId: '730',
        SteamOverlayGameId: '730',
      },
    });
  } catch (e) {
    try {
      if (outFd != null) fs.closeSync(outFd);
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      phase: 'failed',
      error: 'spawn_failed',
      message: e?.message || String(e),
      host,
      port,
      password,
      map,
      cs2Path: paths.exe,
      logPath,
    };
  }

  dedicatedMeta = {
    pid: dedicatedChild.pid,
    map,
    port,
    host,
    lanHost,
    publicHost: publicHost || '',
    password,
    hostname,
    cheats,
    startedAt: Date.now(),
    cs2Path: paths.exe,
    logPath,
    gameRoot: paths.gameRoot,
    cfgDir: paths.cfgDir,
    steamGameRoot: paths.steamGameRoot,
    overlay: true,
    modsOk: !!mods.ok,
    modsError: mods.error || '',
    gslt: gslt || '',
    adminSettings: opts?.adminSettings || null,
    soundSettings: soundSettings || matchServerMods.defaultKillSoundsSettings(),
    welcomeMessage: String(opts?.welcomeMessage || '').trim().slice(0, 200) || '',
    welcomeColor: String(opts?.welcomeColor || 'green').trim().toLowerCase().slice(0, 24) || 'green',
  };

  dedicatedChild.on('exit', (code) => {
    try {
      if (outFd != null) fs.closeSync(outFd);
    } catch {
      /* ignore */
    }
    if (dedicatedMeta && dedicatedMeta.pid === dedicatedChild?.pid) {
      dedicatedMeta = { ...dedicatedMeta, exited: true, exitCode: code };
    }
    dedicatedChild = null;
    try {
      require('./match-tunnel').stop();
    } catch {
      /* ignore */
    }
  });

  progress(
    'waiting_ready',
    `Dedicated PID ${dedicatedChild.pid} · a aguardar log + UDP :${port}…`,
    { pid: dedicatedChild.pid, port },
  );

  const readyP = waitForDedicatedReady(
    port,
    120000,
    () => readLogFile(logPath),
    () => !!(dedicatedChild && !dedicatedChild.killed && dedicatedChild.exitCode == null),
    (tick) => {
      const parts = [`${tick.elapsedSec}s`];
      parts.push(tick.sawLog ? 'log OK' : 'à espera do log');
      parts.push(tick.sawUdp ? `UDP ${port} OK` : `UDP ${port}…`);
      progress('waiting_ready', `A subir dedicated · ${parts.join(' · ')}`, {
        pid: dedicatedMeta?.pid,
        port,
      });
    },
  );
  const publicP = fetchPublicIpv4();
  const ready = await readyP;
  publicHost = (await publicP) || '';
  host = publicHost || lanHost;
  if (dedicatedMeta && dedicatedMeta.pid === dedicatedChild?.pid) {
    dedicatedMeta = { ...dedicatedMeta, host, lanHost, publicHost };
  }
  const logBuf = readLogFile(logPath);
  const tokenBad =
    /invalid.*login.*token|Gameserver.*login.*token| steamticket|SteamGameServer_Init failed/i.test(
      logBuf,
    );

  if (!ready.ok || !ready.confirmed || tokenBad) {
    const exited = !dedicatedChild || dedicatedChild.exitCode != null || ready.earlyExit;
    const pid = dedicatedMeta?.pid;
    const detail = summarizeDedicatedFailure(logBuf);
    await stopDedicated();
    return {
      ok: false,
      phase: 'failed',
      error: tokenBad
        ? 'gslt_rejected'
        : exited
          ? 'dedicated_exited'
          : ready.via === 'udp-only'
            ? 'not_fully_ready'
            : 'port_timeout',
      message: tokenBad
        ? 'Steam rejeitou o GSLT. Regenera token App ID 730.'
        : exited
          ? `Dedicated encerrou cedo: ${detail}`
          : ready.via === 'udp-only'
            ? 'UDP ok mas log não confirmou ready — connect bloqueado.'
            : `Dedicated não ficou ready em 120s (${detail}).`,
      host,
      port,
      password,
      map,
      cs2Path: paths.exe,
      logTail: logBuf.slice(-1200),
      logPath,
      pid,
      needsGslt: tokenBad,
      readyConfirmed: false,
    };
  }

  await allowUdpFirewall(port);
  progress('network', `Firewall OK · a tentar UPnP na porta ${port}…`);
  let upnp = { ok: false };
  try {
    upnp = await require('./match-upnp').openUdp(port, lanHost);
  } catch (e) {
    upnp = { ok: false, error: e?.message || String(e) };
  }
  if (dedicatedMeta && dedicatedMeta.pid === dedicatedChild?.pid) {
    dedicatedMeta = { ...dedicatedMeta, host, lanHost, publicHost, upnp };
  }

  await sleep(4000);

  const guestEndpoint = publicHost ? `${publicHost}:${port}` : `${lanHost}:${port}`;
  let message = publicHost
    ? upnp.ok
      ? `Dedicated ready · amigos entram em ${guestEndpoint} (porta aberta no router)`
      : `Dedicated ready · ${guestEndpoint}. Se os amigos não entram, abre UDP ${port} no router (UPnP falhou).`
    : `Dedicated ready na LAN ${lanHost}:${port}. Sem IP público — encaminha UDP ${port} no router.`;
  if (!mods.ok) {
    message += ` · aviso: plugin de times não instalado (${mods.error || 'mods'}).`;
  } else {
    message += ' · times pelo dedicated (SteamID/nome).';
  }
  message += ' · overlay (Steam gameinfo intacto).';

  // Reaplica cvars via plugin (mapa já carregou) + restart para dinheiro/warmup
  if (dedicatedMeta?.adminSettings) {
    void applyAdminSettings({ ...dedicatedMeta.adminSettings, restart: true });
  }
  startAdminReapply();
  // Welcome fica a cargo do plugin (PrintToChat verde) — não usar `say` (fica branco Console:)

  return {
    ok: true,
    stub: false,
    dedicated: true,
    phase: 'listening',
    readyConfirmed: true,
    host,
    port,
    password,
    map,
    hostname,
    cheats,
    pid: dedicatedMeta?.pid,
    cs2Path: paths.exe,
    readyVia: ready.via,
    logPath,
    cfgDir: dedicatedMeta?.cfgDir || paths.cfgDir,
    connectString: buildConnectCmd(host, port, password),
    lanHost,
    publicHost: publicHost || '',
    upnpOk: !!upnp.ok,
    modsOk: !!mods.ok,
    modsError: mods.error || '',
    message,
    logTail: logBuf.slice(-800),
  };
}

async function connectToServer(opts) {
  let host = String(opts?.host || '').trim();
  let port = Number(opts?.port) || 27016;
  const password = String(opts?.password || '').trim();
  if (!host) return { ok: false, error: 'missing_host' };

  const localDedicated = !!(dedicatedChild && !dedicatedChild.killed && dedicatedMeta?.port);
  if (localDedicated) {
    host = '127.0.0.1';
    port = Number(dedicatedMeta.port) || port;
  }

  const connectCmd = buildConnectCmd(host, port, password);
  const steamConnectUri = password
    ? `steam://connect/${host}:${port}/${encodeURIComponent(password)}`
    : `steam://connect/${host}:${port}`;

  try {
    clipboard.writeText(connectCmd);
  } catch {
    /* ignore */
  }

  const paths = await resolveCs2Paths();
  writeConnectCfgAll(paths, connectCmd);
  const teamsCfg =
    (dedicatedMeta && dedicatedMeta.cfgDir) ||
    (opts?.userDataPath
      ? path.join(opts.userDataPath, 'cs2-overlay', 'game', 'csgo', 'cfg')
      : '') ||
    paths.cfgDir;
  matchServerMods.writeTeamsFile(teamsCfg, opts?.players || []);

  const clientUp = await isCs2ClientRunning();
  let via = 'clipboard';
  const uriRes = await runSteamUri(steamConnectUri);
  const steamUriOk = !!uriRes?.ok;
  if (steamUriOk) via = 'steam-connect-uri';

  if (!clientUp) {
    const steamExe = await resolveSteamExe();
    const launchArgs = ['-applaunch', '730'];
    if (password) launchArgs.push('+password', password);
    launchArgs.push('+connect', `${host}:${port}`);
    const launched = await launchSteamArgs(steamExe, launchArgs);
    if (launched.ok) via = steamUriOk ? 'steam-uri+applaunch' : 'applaunch-connect';
    else if (!steamUriOk) via = 'launch-fail';
  }

  return {
    ok: true,
    connectString: connectCmd,
    steamConnectUri,
    copied: true,
    injected: false,
    steamUriTried: true,
    steamUriOk,
    relaunched: false,
    gameWasOpen: clientUp,
    steamLaunch: !clientUp,
    cfgWritten: true,
    via,
    note:
      'Connect via Steam. O dedicated coloca-te no time do veto (plugin), sem consola nem cliques.',
  };
}

async function openCs2Only() {
  const steamExe = await resolveSteamExe();
  const r = await launchSteamArgs(steamExe, ['-applaunch', '730']);
  if (!r.ok) await runSteamUri('steam://rungameid/730');
  return { ok: true };
}

function resolveDedicatedCfgDir() {
  return (
    dedicatedMeta?.cfgDir ||
    (dedicatedMeta?.gameRoot ? path.join(dedicatedMeta.gameRoot, 'csgo', 'cfg') : '') ||
    ''
  );
}

function isDedicatedAlive() {
  return !!(dedicatedChild && !dedicatedChild.killed && dedicatedChild.exitCode == null);
}

/**
 * Envia comandos ao dedicated via sf_pm_cmd.json (plugin CSS).
 * stdin do cs2 -dedicated NÃO é fiável — não usar como caminho principal.
 */
async function dedicatedExec(cmd, { waitMs = 2000 } = {}) {
  return dedicatedExecMany([cmd], { waitMs });
}

async function dedicatedExecMany(cmds, { waitMs = 2500 } = {}) {
  const list = (Array.isArray(cmds) ? cmds : [cmds])
    .map((c) => String(c || '').trim())
    .filter(Boolean);
  if (!list.length) return { ok: false, error: 'empty' };
  if (!isDedicatedAlive()) {
    return { ok: false, error: 'dedicated_not_running' };
  }
  const cfgDir = resolveDedicatedCfgDir();
  if (!cfgDir) return { ok: false, error: 'no_cfg' };

  const seq = Date.now();
  const written = matchServerMods.writeCmdFile(cfgDir, list, seq);
  if (!written.ok) return written;

  // Fallback stdin (muitas builds de CS2 ignoram — não é a fonte da verdade)
  try {
    if (dedicatedChild?.stdin && !dedicatedChild.stdin.destroyed) {
      for (const c of list) dedicatedChild.stdin.write(`${c}\n`);
    }
  } catch {
    /* ignore */
  }

  if (!waitMs || waitMs <= 0) {
    return { ok: true, via: 'plugin_queued', seq, cmds: list };
  }

  const ackPath = path.join(cfgDir, 'sf_pm_cmd_ack.json');
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(90);
    try {
      if (!fs.existsSync(ackPath)) continue;
      const j = JSON.parse(fs.readFileSync(ackPath, 'utf8'));
      if (Number(j.seq) !== seq) continue;
      const failed = Number(j.failed) || 0;
      const details = Array.isArray(j.details) ? j.details : [];
      if (failed > 0) {
        return {
          ok: false,
          error: 'plugin_exec_partial',
          via: 'plugin',
          seq,
          cmds: list,
          okCount: Number(j.ok) || 0,
          failed,
          details,
          hint: details.slice(0, 3).join(' · ') || undefined,
        };
      }
      return {
        ok: true,
        via: 'plugin',
        seq,
        cmds: list,
        okCount: Number(j.ok) || list.length,
        failed: 0,
        details,
      };
    } catch {
      /* ignore parse races */
    }
  }

  return {
    ok: false,
    error: 'plugin_no_ack',
    hint:
      'O plugin SfAssignTeams não confirmou o comando. Reinicia o dedicated no Desktop (DLL 1.2.5+).',
    seq,
    cmds: list,
  };
}

function rewriteTeams(players) {
  const cfgDir = resolveDedicatedCfgDir();
  if (!cfgDir) return { ok: false, error: 'no_cfg' };
  return matchServerMods.writeTeamsFile(cfgDir, players || []);
}

function rewriteAdmin(settings, welcomeMessage, welcomeColor) {
  const cfgDir = resolveDedicatedCfgDir();
  if (!cfgDir) return { ok: false, error: 'no_cfg' };
  const merged = {
    ...(dedicatedMeta?.adminSettings || {}),
    ...(settings || {}),
  };
  const welcome =
    welcomeMessage != null
      ? String(welcomeMessage)
      : dedicatedMeta?.welcomeMessage || '';
  const color =
    welcomeColor != null
      ? String(welcomeColor)
      : dedicatedMeta?.welcomeColor || 'green';
  const r = matchServerMods.writeAdminFile(cfgDir, merged, welcome, color);
  if (dedicatedMeta) {
    dedicatedMeta = {
      ...dedicatedMeta,
      adminSettings: merged,
      welcomeMessage: String(welcome || '').trim(),
      welcomeColor: String(color || 'green').trim().toLowerCase(),
    };
  }
  // Plugin reaplica via JSON + fila
  void applyAdminSettings({ ...merged, restart: false });
  return r;
}

function applySoundSettings(settings) {
  const cfgDir = resolveDedicatedCfgDir();
  if (!cfgDir) return { ok: false, error: 'no_cfg' };
  const merged = {
    ...matchServerMods.defaultKillSoundsSettings(),
    ...(dedicatedMeta?.soundSettings || {}),
    ...(settings || {}),
    events: {
      ...matchServerMods.defaultKillSoundsSettings().events,
      ...((dedicatedMeta?.soundSettings && dedicatedMeta.soundSettings.events) || {}),
      ...((settings && settings.events) || {}),
    },
  };
  const r = matchServerMods.writeSoundsFile(cfgDir, merged);
  if (dedicatedMeta) {
    dedicatedMeta = { ...dedicatedMeta, soundSettings: r.settings || merged };
  }
  return r;
}

async function applyAdminSettings(settings) {
  if (!settings || typeof settings !== 'object') return { ok: false, error: 'empty' };
  if (!isDedicatedAlive()) {
    return { ok: false, error: 'dedicated_not_running' };
  }
  const welcomeIn =
    settings.welcome_message != null ? String(settings.welcome_message) : undefined;
  const colorIn =
    settings.welcome_color != null ? String(settings.welcome_color) : undefined;
  const { welcome_message: _w, welcome_color: _c, restart: wantRestart, ...cvarSettings } =
    settings;

  // 1) Grava cfg + JSON do plugin ANTES de executar
  try {
    if (dedicatedMeta?.cfgDir) {
      const merged = {
        ...(dedicatedMeta.adminSettings || {}),
        ...cvarSettings,
      };
      delete merged.restart;
      delete merged.welcome_message;
      delete merged.welcome_color;
      const welcome =
        welcomeIn != null ? welcomeIn : dedicatedMeta.welcomeMessage || '';
      const color =
        colorIn != null ? colorIn : dedicatedMeta.welcomeColor || 'green';
      writeServerCfg(dedicatedMeta.cfgDir, {
        password: dedicatedMeta.password,
        gslt: dedicatedMeta.gslt || '',
        hostname: dedicatedMeta.hostname,
        cheats:
          cvarSettings.sv_cheats != null
            ? Number(cvarSettings.sv_cheats) === 1
            : dedicatedMeta.cheats,
        adminSettings: merged,
        soundSettings: dedicatedMeta.soundSettings || null,
      });
      matchServerMods.writeAdminFile(dedicatedMeta.cfgDir, merged, welcome, color);
      dedicatedMeta = {
        ...dedicatedMeta,
        adminSettings: merged,
        welcomeMessage: String(welcome || '').trim(),
        welcomeColor: String(color || 'green').trim().toLowerCase(),
        cheats:
          cvarSettings.sv_cheats != null
            ? Number(cvarSettings.sv_cheats) === 1
            : dedicatedMeta.cheats,
      };
    } else if (dedicatedMeta) {
      dedicatedMeta = {
        ...dedicatedMeta,
        adminSettings: {
          ...(dedicatedMeta.adminSettings || {}),
          ...cvarSettings,
        },
      };
    }
  } catch (e) {
    return { ok: false, error: e?.message || 'write_admin_failed' };
  }

  // 2) Fila no plugin: competitive cfg primeiro, depois overrides (senão o exec apaga o maxmoney)
  const cmds = [
    'exec gamemode_competitive_server',
    'sf_reload_admin',
    ...expandAdminCommands({ ...cvarSettings, restart: false }),
    'mp_maxmoney 65000',
    'mp_teamcashawards 1',
    'mp_playercashawards 1',
  ];
  if (wantRestart) {
    const start = Number(cvarSettings.mp_startmoney ?? dedicatedMeta?.adminSettings?.mp_startmoney);
    if (Number.isFinite(start) && start > 0) cmds.push(`sf_set_money ${Math.round(start)}`);
    cmds.push('mp_restartgame 1');
  }

  const execResult = await dedicatedExecMany(cmds, { waitMs: 3500 });
  if (!execResult.ok) {
    return {
      ok: false,
      error: execResult.error || 'exec_failed',
      hint: execResult.hint,
      results: [execResult],
      settings: dedicatedMeta?.adminSettings,
    };
  }
  return {
    ok: true,
    via: execResult.via || 'plugin',
    results: [execResult],
    settings: dedicatedMeta?.adminSettings,
  };
}

async function applyAdminBots(action) {
  const a = String(action || '').toLowerCase();
  let cmd = '';
  if (a === 'add_ct') cmd = 'bot_add_ct';
  else if (a === 'add_t') cmd = 'bot_add_t';
  else if (a === 'kick') cmd = 'bot_kick';
  else return { ok: false, error: 'bad_bot_action' };
  return dedicatedExec(cmd, { waitMs: 2500 });
}

function accountIdToSteam64(accountId) {
  try {
    return String(BigInt('76561197960265728') + BigInt(accountId));
  } catch {
    return '';
  }
}

/**
 * Extrai jogadores ligados a partir do log do dedicated.
 * CS2 muitas vezes não imprime o dump clássico do `status` no log —
 * usa linhas "Name<id><[U:1:acc]><TEAM>" e Dropped.
 */
function parseStatusPlayers(logTail) {
  const bySteam = new Map(); // steamid → { name, steamid, inServer }
  const byNameOnly = new Map();

  const upsert = (name, steamid, inServer) => {
    const nm = String(name || '').trim();
    const sid = String(steamid || '').replace(/\D/g, '');
    if (sid) {
      const prev = bySteam.get(sid) || { name: nm, steamid: sid, inServer: false };
      bySteam.set(sid, {
        name: nm || prev.name,
        steamid: sid,
        inServer: inServer != null ? !!inServer : prev.inServer,
      });
      return;
    }
    if (!nm) return;
    const key = nm.toLowerCase();
    const prev = byNameOnly.get(key) || { name: nm, steamid: '', inServer: false };
    byNameOnly.set(key, {
      name: nm,
      steamid: '',
      inServer: inServer != null ? !!inServer : prev.inServer,
    });
  };

  const lines = String(logTail || '').split(/\r?\n/);
  for (const line of lines) {
    // "A L E X<2><[U:1:333510071]><TERRORIST>"
    const tagged = line.match(/"([^"<]+)<\d+><\[U:1:(\d+)\]><[^"]*>"/);
    if (tagged) {
      upsert(tagged[1], accountIdToSteam64(tagged[2]), true);
      continue;
    }
    // STEAM USERID validated
    const validated = line.match(/"([^"<]+)<\d+><\[U:1:(\d+)\]><[^"]*>"\s+STEAM USERID validated/i);
    if (validated) {
      upsert(validated[1], accountIdToSteam64(validated[2]), true);
      continue;
    }
    // Connect( name='…'
    const conn = line.match(/Connect\(\s*name='([^']+)'/i);
    if (conn) {
      upsert(conn[1], '', true);
      continue;
    }
    // Dropped "Name<…><[U:1:…]>" — não usar "Disconnect" genérico (muitos falsos positivos)
    if (/Dropped\s+"/i.test(line) || /Client .+ disconnected/i.test(line)) {
      const drop = line.match(/"([^"<]+)<\d+><\[U:1:(\d+)\]>/);
      if (drop) {
        upsert(drop[1], accountIdToSteam64(drop[2]), false);
        continue;
      }
      const dropName = line.match(/Dropped\s+"([^"<]+)/i);
      if (dropName) upsert(dropName[1], '', false);
      continue;
    }
    // # userid slot "Name" [U:1:acc]  (status dump clássico)
    const m = line.match(
      /#\s*\d+\s+\d+\s+"([^"]+)"\s+(?:\[U:1:(\d+)\]|STEAM_[0-5]:([01]):(\d+)|(\d{17}))/i,
    );
    if (m) {
      let steamid = '';
      if (m[2]) steamid = accountIdToSteam64(m[2]);
      else if (m[3] != null && m[4] != null) {
        steamid = accountIdToSteam64(Number(m[4]) * 2 + Number(m[3]));
      } else if (m[5]) steamid = m[5];
      upsert(m[1], steamid, true);
      continue;
    }
    const simple = line.match(/#\s*\d+\s+\d+\s+"([^"]+)"/);
    if (simple) upsert(simple[1], '', true);
  }

  const players = [];
  const seen = new Set();
  for (const p of bySteam.values()) {
    if (!p.inServer) continue;
    seen.add(p.steamid);
    players.push({ name: p.name, steamid: p.steamid });
  }
  for (const p of byNameOnly.values()) {
    if (!p.inServer) continue;
    const key = p.name.toLowerCase();
    if (seen.has(key)) continue;
    // se já temos o mesmo nome com steam, skip
    if ([...bySteam.values()].some((x) => x.inServer && x.name.toLowerCase() === key)) continue;
    players.push({ name: p.name, steamid: '' });
  }
  return players;
}

async function dedicatedSnapshot() {
  const meta = dedicatedMeta;
  const child = dedicatedChild;
  const running = !!(child && !child.killed);
  if (running) {
    void dedicatedExec('status', { waitMs: 0 });
    await sleep(600);
  }
  const logPath = meta?.logPath || '';
  // Tail maior: eventos Connect/Drop não podem cair fora do buffer
  const logTail = logPath ? readLogFile(logPath).slice(-80000) : '';
  return {
    ok: true,
    running,
    pid: meta?.pid || child?.pid || null,
    host: meta?.host || null,
    port: meta?.port || null,
    map: meta?.map || null,
    password: meta?.password || null,
    hostname: meta?.hostname || null,
    cheats: !!meta?.cheats,
    startedAt: meta?.startedAt || null,
    exited: !!meta?.exited,
    logPath: logPath || null,
    logTail,
    playersInServer: parseStatusPlayers(logTail),
  };
}

function dedicatedStatus() {
  const meta = dedicatedMeta;
  const child = dedicatedChild;
  return {
    ok: true,
    running: !!(child && !child.killed),
    pid: meta?.pid || child?.pid || null,
    host: meta?.host || null,
    port: meta?.port || null,
    map: meta?.map || null,
    password: meta?.password || null,
    hostname: meta?.hostname || null,
    cheats: !!meta?.cheats,
    startedAt: meta?.startedAt || null,
    exited: !!meta?.exited,
    cs2Path: meta?.cs2Path || null,
    readyConfirmed: !!(meta && !meta.exited && child && !child.killed),
  };
}

module.exports = {
  connectToServer,
  openCs2Only,
  prepareHostListen,
  stopDedicated,
  dedicatedStatus,
  dedicatedSnapshot,
  dedicatedExec,
  dedicatedExecMany,
  rewriteTeams,
  rewriteAdmin,
  applyAdminSettings,
  applySoundSettings,
  applyAdminBots,
  pickFreeUdpPort,
  sleep,
  resolveSteamExe,
  resolveCs2Paths,
};
