/**
 * Lab isolado (fora do Electron UI):
 * - sobe dedicated com overlay + Metamod/CSS/SfAssignTeams
 * - roster: SteamID do host no TR
 * - conecta o cliente CS2
 * - reporta no log se os plugins carregaram / assign
 *
 * Uso: node scripts/lab-dedicated-tr.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const matchConnect = require('../match-connect');

const STEAM_ID = '76561198000000000';
const USER_DATA = path.join(os.homedir(), 'AppData', 'Roaming', 'SteamFarm-Comunidade-localdev');
const PASSWORD = 'labtr01';
const MAP = 'mirage';

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
    /\[META\].*/gi,
    /metamod-fatal|could not load|procedimento especificado/gi,
    /CounterStrikeSharp|CSS#|SfAssignTeams/gi,
    /Loaded \d+ plugins/gi,
  ];
  const hits = [];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) hits.push(...m.slice(-8));
  }
  return { text, hits: [...new Set(hits)].slice(-40) };
}

async function main() {
  console.log('[lab] SteamID', STEAM_ID, '→ TR');
  console.log('[lab] userData', USER_DATA);

  const gsltPath = path.join(USER_DATA, 'cs2-gslt.txt');
  const gslt = fs.existsSync(gsltPath) ? fs.readFileSync(gsltPath, 'utf8').trim() : '';
  if (!gslt) {
    console.error('[lab] falta GSLT em', gsltPath);
    process.exit(1);
  }

  const host = await matchConnect.prepareHostListen({
    userDataPath: USER_DATA,
    password: PASSWORD,
    map: MAP,
    port: 27015,
    gslt,
    hostname: 'SF-LAB-TR',
    cheats: true,
    players,
    onProgress: (p) => console.log('[lab:progress]', p.phase, p.message || ''),
  });

  console.log('[lab] prepareHostListen', {
    ok: host.ok,
    error: host.error,
    message: host.message,
    host: host.host,
    port: host.port,
    password: host.password,
    modsOk: host.modsOk,
    logPath: host.logPath,
  });

  if (!host.ok) {
    const scan = scanLog(host.logPath || path.join(USER_DATA, 'sf-cs2-dedicated.log'));
    console.log('[lab] log hits', scan.hits);
    process.exit(2);
  }

  // Reescreve roster explicitamente (garantia)
  const rewritten = matchConnect.rewriteTeams(players);
  console.log('[lab] rewriteTeams', rewritten);

  await sleep(2500);
  let scan = scanLog(host.logPath);
  console.log('[lab] plugins/log (pré-connect):');
  for (const h of scan.hits) console.log('  ', h);

  const metaLoaded = /Loaded\s+[1-9]\d*\s+plugins/i.test(scan.text);
  const hasAssign = /SfAssignTeams/i.test(scan.text);
  const hasCss = /CounterStrikeSharp|CSS#/i.test(scan.text);
  console.log('[lab] checklist pré-connect', { metaLoaded, hasCss, hasAssign });

  const conn = await matchConnect.connectToServer({
    host: '127.0.0.1',
    port: host.port,
    password: PASSWORD,
    userDataPath: USER_DATA,
    players,
  });
  console.log('[lab] connectToServer', conn);

  console.log('[lab] Aguardando 25s para assign no log…');
  await sleep(25000);
  scan = scanLog(host.logPath);
  console.log('[lab] plugins/log (pós-connect):');
  for (const h of scan.hits) console.log('  ', h);

  const assigned = /SfAssignTeams].*assign.*Terrorist|assign.*->\s*Terrorist/i.test(scan.text);
  console.log('\n========== RESULTADO LAB ==========');
  console.log('SteamID:', STEAM_ID, 'time pedido: TR');
  console.log('Connect:', conn.connectString || conn.steamConnectUri);
  console.log('Metamod com plugins (>0):', /Loaded\s+[1-9]/i.test(scan.text));
  console.log('CounterStrikeSharp no log:', /CounterStrikeSharp|CSS#/i.test(scan.text));
  console.log('SfAssignTeams no log:', /SfAssignTeams/i.test(scan.text));
  console.log('Assign TR visto no log:', assigned);
  console.log('Dedicated continua a correr — fecha o CS2/dedicated quando acabares o teste.');
  console.log('===================================\n');
  console.log('Pergunta para ti: entraste já no TR sem ecrã de escolha de time? Responde "funcionou" ou descreve o que viste.');

  // Mantém o processo vivo — dedicated é filho deste Node.
  setInterval(() => {
    const st = matchConnect.dedicatedStatus?.() || {};
    if (st.running === false || st.exited) {
      console.log('[lab] dedicated encerrou', st);
    }
  }, 30000);
}

main().catch((e) => {
  console.error('[lab] fatal', e);
  process.exit(1);
});
