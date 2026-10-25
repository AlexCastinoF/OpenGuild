/**
 * Lab dinheiro: dedicated no overlay @steamfarm/desktop + comandos sf_*_money.
 *
 * Uso: node scripts/lab-money-live.js
 *
 * No CS2 (já ligado ou reconnect):
 * 1) Deves começar com $16000
 * 2) Chat: drops de vitória/derrota / set
 * Confirme no chat do CS2 quando o dinheiro mudar.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const matchConnect = require('../match-connect');
const matchServerMods = require('../match-server-mods');

const STEAM_ID = '76561198000000000';
const USER_DATA = path.join(os.homedir(), 'AppData', 'Roaming', '@steamfarm', 'desktop');
const PASSWORD = 'labmoney1';
const MAP = 'mirage';
const PORT = 27015;

const ADMIN = {
  mp_startmoney: 16000,
  mp_maxmoney: 65000,
  mp_roundtime: 1.92,
  mp_freezetime: 5,
  mp_buytime: 20,
  mp_limitteams: 0,
  mp_spectators: 1,
  mp_warmuptime: 30,
  cash_player_killed_enemy_default: 500,
  cash_team_winner_bonus: 4000,
  cash_team_loser_bonus: 2000,
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

function cfgDir() {
  return path.join(USER_DATA, 'cs2-overlay', 'game', 'csgo', 'cfg');
}

async function pushCmds(label, cmds) {
  console.log(`\n=== ${label} ===`);
  console.log(cmds);
  const r = await matchConnect.dedicatedExecMany(cmds, { waitMs: 4000 });
  console.log('[result]', JSON.stringify(r, null, 2));
  return r;
}

async function main() {
  const mode = process.argv[2] || 'boot';

  if (mode === 'cmd') {
    // Junta "sf_add_money" "5000" → "sf_add_money 5000"
    const raw = process.argv.slice(3);
    const cmds = [];
    for (let i = 0; i < raw.length; i++) {
      const t = raw[i];
      if (/^\d+(\.\d+)?$/.test(t) && cmds.length) {
        cmds[cmds.length - 1] = `${cmds[cmds.length - 1]} ${t}`;
      } else {
        cmds.push(t);
      }
    }
    if (!cmds.length) {
      console.error('Uso: node lab-money-live.js cmd sf_add_money 4000');
      process.exit(1);
    }
    const dir = cfgDir();
    const seq = Date.now();
    matchServerMods.writeCmdFile(dir, cmds, seq);
    console.log('wrote', path.join(dir, 'sf_pm_cmd.json'), cmds);
    // Espera ack mesmo sem child handle (dedicated orphan)
    const ackPath = path.join(dir, 'sf_pm_cmd_ack.json');
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      await sleep(100);
      try {
        if (!fs.existsSync(ackPath)) continue;
        const j = JSON.parse(fs.readFileSync(ackPath, 'utf8'));
        if (Number(j.seq) === seq) {
          console.log(JSON.stringify(j, null, 2));
          return;
        }
      } catch {
        /* ignore */
      }
    }
    console.log(JSON.stringify({ ok: false, error: 'plugin_no_ack', cmds }, null, 2));
    return;
  }

  console.log('[lab-money] SteamID', STEAM_ID);
  console.log('[lab-money] USER_DATA', USER_DATA);
  console.log('[lab-money] ADMIN', ADMIN);

  const gsltPath = path.join(USER_DATA, 'cs2-gslt.txt');
  let gslt = fs.existsSync(gsltPath) ? fs.readFileSync(gsltPath, 'utf8').trim() : '';
  if (!gslt) {
    // fallback localdev
    const alt = path.join(
      os.homedir(),
      'AppData',
      'Roaming',
      'SteamFarm-Comunidade-localdev',
      'cs2-gslt.txt',
    );
    if (fs.existsSync(alt)) gslt = fs.readFileSync(alt, 'utf8').trim();
  }
  if (!gslt) {
    console.error('[lab-money] falta GSLT');
    process.exit(1);
  }

  console.log('[lab-money] a parar dedicated actual…');
  try {
    await matchConnect.stopDedicated();
  } catch {
    /* ignore */
  }
  // mata qualquer cs2 -dedicated residual
  try {
    const { execSync } = require('child_process');
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='cs2.exe'\\" | Where-Object { $_.CommandLine -match '-dedicated' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore', windowsHide: true },
    );
  } catch {
    /* ignore */
  }
  await sleep(1500);

  // Garante DLL novo no resources → ensure overlay copia
  const host = await matchConnect.prepareHostListen({
    userDataPath: USER_DATA,
    password: PASSWORD,
    map: MAP,
    port: PORT,
    gslt,
    hostname: 'SF-LAB-MONEY',
    cheats: true,
    players,
    adminSettings: ADMIN,
    welcomeMessage: 'LAB MONEY 16k→65k',
    onProgress: (p) => console.log('[lab:progress]', p.phase, p.message || ''),
  });

  console.log('[lab-money] host', {
    ok: host.ok,
    error: host.error,
    message: host.message,
    host: host.host,
    port: host.port,
    password: host.password,
    logPath: host.logPath,
    cfgDir: host.cfgDir,
  });

  if (!host.ok) process.exit(2);

  matchConnect.rewriteTeams(players);
  matchConnect.rewriteAdmin(ADMIN, 'LAB MONEY 16k→65k', 'green');

  console.log('\nLiga-te: connect', `${host.host || '127.0.0.1'}:${host.port}; password ${PASSWORD}`);
  console.log('password', PASSWORD);
  console.log('À espera 25s para mapa/plugin…');
  await sleep(25000);

  await pushCmds('force maxmoney + dump', [
    'mp_maxmoney 65000',
    'mp_startmoney 16000',
    'mp_teamcashawards 1',
    'mp_playercashawards 1',
    'sf_dump_money',
  ]);

  await sleep(2000);
  await pushCmds('set wallet 16000 (Account API)', ['sf_set_money 16000', 'sf_dump_money']);

  await sleep(2000);
  await pushCmds('sim vitória +4000', ['sf_money_win 4000', 'sf_dump_money']);

  await sleep(2000);
  await pushCmds('sim derrota +2000', ['sf_money_lose 2000', 'sf_dump_money']);

  await sleep(2000);
  await pushCmds('add +5000 (deve passar 16k)', ['sf_add_money 5000', 'sf_dump_money']);

  console.log('\n[lab-money] sequência enviada.');
  console.log('Olha o dinheiro no jogo. Se não mudou, corre:');
  console.log('  node scripts/lab-money-live.js cmd sf_add_money 5000');
  console.log('Dedicated fica a correr. Ctrl+C neste terminal NÃO mata o cs2.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
