/**
 * Lab isolado (fora do Electron UI):
 * - dedicated + plugin SfAssignTeams
 * - testa: start money, warmup, mensagem de boas-vindas (+ assign TR)
 *
 * Uso: node scripts/lab-dedicated-admin.js
 *
 * No CS2 verifica:
 * 1) Chat / centro: "LAB WELCOME OpenGuild"
 * 2) Warmup activo ~45s
 * 3) Dinheiro inicial ~15500 no buy
 * 4) Time TR (como antes)
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const matchConnect = require('../match-connect');

const STEAM_ID = '76561198000000000';
const USER_DATA = path.join(os.homedir(), 'AppData', 'Roaming', 'SteamFarm-Comunidade-localdev');
const PASSWORD = 'labadm01';
const MAP = 'mirage';
const PORT = 27015;

const WELCOME = 'LAB WELCOME OpenGuild';
const ADMIN = {
  mp_startmoney: 15500,
  mp_roundtime: 1.92,
  mp_freezetime: 15,
  mp_buytime: 20,
  mp_limitteams: 0,
  mp_spectators: 1,
  mp_warmuptime: 45,
};

const players = [
  {
    userId: 1,
    steamid: STEAM_ID,
    name: 'Player',
    username: 'player',
    displayName: 'Player',
    team: 'T',
  },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function scanLog(logPath) {
  let text = '';
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch {
    return { text: '', hits: [] };
  }
  const patterns = [
    /\[SfAssignTeams\].*/gi,
    /admin apply.*/gi,
    /Loaded \d+ plugins/gi,
    /metamod-fatal|could not load/gi,
  ];
  const hits = [];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) hits.push(...m.slice(-12));
  }
  return { text, hits: [...new Set(hits)].slice(-50) };
}

async function main() {
  console.log('[lab-admin] SteamID', STEAM_ID);
  console.log('[lab-admin] settings', ADMIN);
  console.log('[lab-admin] welcome', WELCOME);

  // Mata dedicated antigo se ainda estiver a correr
  try {
    await matchConnect.stopDedicated();
  } catch {
    /* ignore */
  }
  await sleep(800);

  const gsltPath = path.join(USER_DATA, 'cs2-gslt.txt');
  const gslt = fs.existsSync(gsltPath) ? fs.readFileSync(gsltPath, 'utf8').trim() : '';
  if (!gslt) {
    console.error('[lab-admin] falta GSLT em', gsltPath);
    process.exit(1);
  }

  const host = await matchConnect.prepareHostListen({
    userDataPath: USER_DATA,
    password: PASSWORD,
    map: MAP,
    port: PORT,
    gslt,
    hostname: 'SF-LAB-ADMIN',
    cheats: true,
    players,
    adminSettings: ADMIN,
    welcomeMessage: WELCOME,
    onProgress: (p) => console.log('[lab:progress]', p.phase, p.message || ''),
  });

  console.log('[lab-admin] prepareHostListen', {
    ok: host.ok,
    error: host.error,
    message: host.message,
    host: host.host,
    port: host.port,
    password: host.password,
    modsOk: host.modsOk,
    logPath: host.logPath,
    cfgDir: host.cfgDir,
  });

  if (!host.ok) {
    console.log('[lab-admin] log hits', scanLog(host.logPath || '').hits);
    process.exit(2);
  }

  const cfgDir =
    host.cfgDir ||
    path.join(USER_DATA, 'cs2-overlay', 'game', 'csgo', 'cfg');

  const teams = matchConnect.rewriteTeams(players);
  const admin = matchConnect.rewriteAdmin(ADMIN, WELCOME);
  console.log('[lab-admin] rewriteTeams', teams);
  console.log('[lab-admin] rewriteAdmin', admin);

  const adminFile = path.join(cfgDir, 'sf_pm_admin.json');
  const cfgFile = path.join(cfgDir, 'sf_pm_server.cfg');
  console.log('[lab-admin] sf_pm_admin.json exists=', fs.existsSync(adminFile));
  if (fs.existsSync(adminFile)) {
    console.log(fs.readFileSync(adminFile, 'utf8'));
  }
  if (fs.existsSync(cfgFile)) {
    console.log('[lab-admin] sf_pm_server.cfg (cvars):');
    console.log(
      fs
        .readFileSync(cfgFile, 'utf8')
        .split('\n')
        .filter((l) => /mp_|welcome|hostname/.test(l))
        .join('\n'),
    );
  }

  await sleep(3000);
  let scan = scanLog(host.logPath);
  console.log('[lab-admin] plugin log (pré-connect):');
  for (const h of scan.hits) console.log('  ', h);

  const conn = await matchConnect.connectToServer({
    host: '127.0.0.1',
    port: host.port,
    password: PASSWORD,
    userDataPath: USER_DATA,
    players,
  });
  console.log('[lab-admin] connectToServer', conn);

  console.log('');
  console.log('=== VERIFICA NO CS2 (cliente) ===');
  console.log('1) Mensagem: "' + WELCOME + '" (chat e/ou centro do ecrã)');
  console.log('2) Warmup ~' + ADMIN.mp_warmuptime + 's');
  console.log('3) Start money ~' + ADMIN.mp_startmoney);
  console.log('4) Time TR');
  console.log('Password:', PASSWORD, '· connect 127.0.0.1:' + host.port);
  console.log('Aguardando 35s e a imprimir log do plugin…');
  console.log('');

  await sleep(35000);
  scan = scanLog(host.logPath);
  console.log('[lab-admin] plugin log (após connect):');
  for (const h of scan.hits) console.log('  ', h);

  const okAdmin = /admin apply/i.test(scan.text);
  const okAssign = /assign .+ -> Terrorist/i.test(scan.text);
  console.log('[lab-admin] checklist', { okAdmin, okAssign });
  console.log('[lab-admin] Dedicated continua — fecha CS2/dedicated quando acabares.');
  console.log('[lab-admin] Diz o que funcionou: welcome / money / warmup / TR');

  setInterval(() => {
    const st = matchConnect.dedicatedStatus?.() || {};
    if (st.running === false || st.exited) {
      console.log('[lab-admin] dedicated encerrou', st);
    }
  }, 30000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
