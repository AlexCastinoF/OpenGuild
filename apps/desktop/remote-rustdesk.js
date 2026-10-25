/**
 * Sidecar RustDesk (binário oficial sem modificar).
 *
 * Crítico:
 * - Strings no TOML sempre com aspas (senão Bad TOML → rs-ny).
 * - Nunca usar execSync+UAC no caminho de "status"/arranque — congela o Electron
 *   (UAC fica atrás da janela morta e o utilizador tem de matar o processo).
 * - Elevate só em prepare/connect, e sempre async (spawn) com timeout.
 */
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

function bundledInstallerPath() {
  const packed = path.join(process.resourcesPath || '', 'rustdesk', 'rustdesk.exe');
  if (fs.existsSync(packed)) return packed;
  const dev = path.join(__dirname, 'resources', 'rustdesk', 'rustdesk.exe');
  if (fs.existsSync(dev)) return dev;
  return '';
}

function installedClientPath() {
  const local = path.join(process.env.LOCALAPPDATA || '', 'rustdesk', 'rustdesk.exe');
  if (fs.existsSync(local)) return local;
  const pf = path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'RustDesk', 'rustdesk.exe');
  if (fs.existsSync(pf)) return pf;
  return '';
}

function rustdeskExePath() {
  return installedClientPath() || bundledInstallerPath();
}

function configDir() {
  return path.join(app.getPath('appData'), 'RustDesk', 'config');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runExe(exe, args, { timeoutMs = 20000, windowsHide = true } = {}) {
  return new Promise((resolve) => {
    execFile(
      exe,
      args,
      { windowsHide, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          code: err ? err.code || 1 : 0,
          out: `${stdout || ''}${stderr || ''}`.trim(),
        });
      },
    );
  });
}

/** taskkill async — não bloqueia o event loop do Electron. */
function killRustdesk() {
  return new Promise((resolve) => {
    const child = spawn('taskkill', ['/F', '/IM', 'rustdesk.exe', '/T'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(false);
    }, 8000);
    child.on('exit', () => {
      clearTimeout(t);
      resolve(true);
    });
    child.on('error', () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

/**
 * Uma elevação UAC async. Nunca usar execSync aqui.
 * timeout curto — se o utilizador não aceitar, falha em vez de congelar minutos.
 */
function runElevatedArgs(exe, argsList, timeoutMs = 90000) {
  const exeLit = exe.replace(/'/g, "''");
  const argBlocks = argsList
    .map((args) => {
      const arr = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(', ');
      return `Start-Process -FilePath $exe -ArgumentList @(${arr}) -Verb RunAs -Wait`;
    })
    .join('\n');
  const ps = `
$ErrorActionPreference = 'Stop'
$exe = '${exeLit}'
${argBlocks}
`;
  const scriptPath = path.join(app.getPath('temp'), `sf-rd-elev-${Date.now()}.ps1`);
  fs.writeFileSync(scriptPath, ps, 'utf8');
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true, stdio: 'ignore' },
    );
    let done = false;
    const finish = (fn) => {
      if (done) return;
      done = true;
      try {
        fs.unlinkSync(scriptPath);
      } catch {
        /* ignore */
      }
      fn();
    };
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(() => reject(new Error('uac_timeout: aceite o aviso do Windows (UAC) a tempo')));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(t);
      if (code === 0) finish(() => resolve(true));
      else finish(() => reject(new Error('uac_cancelled_or_failed')));
    });
    child.on('error', (e) => {
      clearTimeout(t);
      finish(() => reject(e));
    });
  });
}

function q(s) {
  return `'${String(s).replace(/'/g, "\\'")}'`;
}

function readConfiguredKey() {
  try {
    const raw = fs.readFileSync(path.join(configDir(), 'RustDesk2.toml'), 'utf8');
    const m = raw.match(/^\s*key\s*=\s*'([^']*)'/m);
    return (m?.[1] || '').trim();
  } catch {
    return '';
  }
}

function buildConfigToml({ idServer, key, relayServer }) {
  const id = String(idServer || '').trim();
  const k = String(key || '').trim();
  const relay = String(relayServer || idServer || '').trim();
  if (!id || !k) return '';
  const hostPort = id.includes(':') ? id : `${id}:21116`;
  // force-always-relay: punch-hole falha com "tente mais tarde" em muitos NATs;
  // relay via hbbr Castino é o caminho estável.
  return [
    `rendezvous_server = ${q(hostPort)}`,
    'nat_type = 1',
    'serial = 0',
    `unlock_pin = ${q('')}`,
    `trusted_devices = ${q('')}`,
    '',
    '[options]',
    `key = ${q(k)}`,
    `custom-rendezvous-server = ${q(id)}`,
    `relay-server = ${q(relay)}`,
    `api-server = ${q('-')}`,
    `force-always-relay = ${q('Y')}`,
    `verification-method = ${q('use-permanent-password')}`,
    `approve-mode = ${q('password')}`,
    `allow-remote-config-modification = ${q('Y')}`,
    '',
  ].join('\n');
}

function buildConfigBase64({ idServer, key, relayServer }) {
  const id = String(idServer || '').trim();
  const k = String(key || '').trim();
  const relay = String(relayServer || idServer || '').trim();
  if (!id || !k) return '';
  return Buffer.from(`${id},${relay},,${k}`, 'utf8').toString('base64');
}

function isOurServerConfigured(idServer) {
  try {
    const p = path.join(configDir(), 'RustDesk2.toml');
    if (!fs.existsSync(p)) return false;
    const raw = fs.readFileSync(p, 'utf8');
    if (/rs-ny\.rustdesk\.com/i.test(raw)) return false;
    const host = String(idServer || '').trim().toLowerCase();
    if (!host) return false;
    return raw.toLowerCase().includes(host) && /key\s*=/.test(raw);
  } catch {
    return false;
  }
}

function newestRustdeskLogPath() {
  const logDir = path.join(app.getPath('appData'), 'RustDesk', 'log');
  if (!fs.existsSync(logDir)) return '';
  const files = fs
    .readdirSync(logDir)
    .filter((n) => /^rustdesk_r20.*\.log$/i.test(n))
    .map((n) => ({ n, t: fs.statSync(path.join(logDir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(logDir, files[0].n) : '';
}

function lastLogTail(maxLines = 60) {
  try {
    const p = newestRustdeskLogPath();
    if (!p) return '';
    const raw = fs.readFileSync(p, 'utf8');
    const lines = raw.split(/\r?\n/);
    return lines.slice(-Math.max(20, maxLines)).join('\n');
  } catch {
    return '';
  }
}

function lastLogSaysPublicServer() {
  try {
    const tail = lastLogTail(80);
    if (!tail) return false;
    const mediators = [...tail.matchAll(/start rendezvous mediator of (\S+)/gi)];
    if (mediators.length) {
      const host = mediators[mediators.length - 1][1] || '';
      if (/vps\.example\.com/i.test(host)) return false;
      if (/rs-ny\.rustdesk\.com/i.test(host)) return true;
    }
    if (/start udp:\s*rs-ny/i.test(tail)) return true;
    if (/Bad TOML data/i.test(tail) && !/mediator of vps\.example\.com/i.test(tail)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function lastLogConnectFailed() {
  const tail = lastLogTail(40);
  return /Failed to connect: the target device is offline|offline or does not exist|ID does not exist|Password incorrect|password is incorrect|Wrong password|incorrect password|Failed to connect to rendezvous|Failed to connect via rendezvous|Please try later/i.test(
    tail,
  );
}

function lastLogUsesOurServer(idServer) {
  const host = String(idServer || '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '');
  if (!host) return false;
  const tail = lastLogTail(80);
  const mediators = [...tail.matchAll(/start rendezvous mediator of (\S+)/gi)];
  if (!mediators.length) return false;
  return (mediators[mediators.length - 1][1] || '').toLowerCase().includes(host);
}

function writeConfigFiles({ idServer, key, relayServer, resetKeyConfirm = false }) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const nextKey = String(key || '').trim();
  const prevKey = readConfiguredKey();
  const keyChanged = !!(nextKey && prevKey && prevKey !== nextKey);
  const toml = buildConfigToml({ idServer, key, relayServer });
  if (!toml) return false;
  fs.writeFileSync(path.join(dir, 'RustDesk2.toml'), toml, 'utf8');
  // Só limpar key_confirmed quando a chave mudou. Limpar em todo heartbeat
  // força register_pk em loop → "Falha ao conectar ao servidor de rendezvous".
  if (resetKeyConfirm || keyChanged || !prevKey) {
    try {
      const localToml = path.join(dir, 'RustDesk.toml');
      if (fs.existsSync(localToml)) {
        let raw = fs.readFileSync(localToml, 'utf8');
        raw = raw.replace(/\[keys_confirmed\][\s\S]*?(?=\n\[|$)/, '[keys_confirmed]\n');
        raw = raw.replace(/key_confirmed\s*=\s*true/gi, 'key_confirmed = false');
        fs.writeFileSync(localToml, raw, 'utf8');
      }
    } catch {
      /* ignore */
    }
  }
  return true;
}

/** Grava senha em claro no TOML (o RustDesk faz hash ao arrancar). */
function writePermanentPasswordPlain(password) {
  const pwd = String(password || '').trim();
  if (!pwd) return false;
  const p = path.join(configDir(), 'RustDesk.toml');
  let raw = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  const line = `password = '${pwd.replace(/'/g, "\\'")}'`;
  if (/^password\s*=/m.test(raw)) {
    raw = raw.replace(/^password\s*=\s*.*$/m, line);
  } else {
    raw = `${line}\n${raw}`;
  }
  fs.writeFileSync(p, raw, 'utf8');
  return true;
}

function permanentPasswordConfigured() {
  try {
    const raw = fs.readFileSync(path.join(configDir(), 'RustDesk.toml'), 'utf8');
    const m = raw.match(/^password\s*=\s*'([^']*)'/m);
    return !!(m && m[1] && m[1].length > 0);
  } catch {
    return false;
  }
}

/**
 * Eleva um script PowerShell completo (async). Janela oculta.
 */
function runElevatedScript(psBody, timeoutMs = 90000) {
  const scriptPath = path.join(app.getPath('temp'), `sf-rd-elev-${Date.now()}.ps1`);
  const wrapper = `
$ErrorActionPreference = 'Continue'
${psBody}
exit 0
`;
  fs.writeFileSync(scriptPath, wrapper, 'utf8');
  const launcher = path.join(app.getPath('temp'), `sf-rd-launch-${Date.now()}.ps1`);
  fs.writeFileSync(
    launcher,
    `
$ErrorActionPreference = 'Continue'
$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','${scriptPath.replace(
      /'/g,
      "''",
    )}') -Verb RunAs -Wait -PassThru -WindowStyle Hidden
if ($null -eq $p) { exit 2 }
exit 0
`,
    'utf8',
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', launcher],
      { windowsHide: true, stdio: 'ignore' },
    );
    let done = false;
    const finish = (fn) => {
      if (done) return;
      done = true;
      for (const f of [scriptPath, launcher]) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* ignore */
        }
      }
      fn();
    };
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(() => reject(new Error('uac_timeout: aceite o aviso do Windows (UAC) a tempo')));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(t);
      // UAC cancel ≈ code 2; resto tratamos como ok se o TOML tiver senha
      if (code === 2) finish(() => reject(new Error('uac_cancelled')));
      else finish(() => resolve(true));
    });
    child.on('error', (e) => {
      clearTimeout(t);
      finish(() => reject(e));
    });
  });
}

function startAgent(exe) {
  try {
    spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}

async function getRustdeskId(exe) {
  const { out } = await runExe(exe, ['--get-id'], { timeoutMs: 12000 });
  const lines = String(out)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const line = lines.find((s) => /^\d{6,}$/.test(s));
  if (line) return line;
  const m = String(out).match(/(\d{6,})/);
  return m?.[1] || '';
}

/** Instalação só sob pedido explícito (prepare/connect) — nunca no arranque. */
async function ensureInstalled() {
  const client = installedClientPath();
  if (client) return client;
  const installer = bundledInstallerPath();
  if (!installer) throw new Error('rustdesk_missing');
  try {
    await runElevatedArgs(installer, [['--silent-install']], 240000);
  } catch {
    await runExe(installer, ['--silent-install'], { timeoutMs: 120000, windowsHide: true });
  }
  await sleep(2500);
  const after = installedClientPath();
  if (!after) throw new Error('rustdesk_install_failed');
  return after;
}

/**
 * Arranque / heartbeat: só ficheiros + ID. SEM kill, SEM UAC, SEM install.
 * Isto evita o freeze ao abrir o app.
 */
async function configureAndGetId({ idServer, key, relayServer }) {
  try {
    // Heartbeat: só reescreve se o servidor desta instalacao / chave ainda não estão certos.
    if (idServer && key) {
      const keyOk = readConfiguredKey() === String(key).trim();
      if (!isOurServerConfigured(idServer) || !keyOk) {
        writeConfigFiles({ idServer, key, relayServer });
      }
    }
    const exe = installedClientPath();
    if (!exe) {
      return {
        ok: false,
        error: 'rustdesk_not_installed',
        exe: rustdeskExePath(),
        rustdeskId: '',
      };
    }
    let rustdeskId = '';
    try {
      rustdeskId = await getRustdeskId(exe);
    } catch {
      rustdeskId = '';
    }
    return {
      ok: true,
      exe,
      rustdeskId: rustdeskId || '',
      configured: idServer ? isOurServerConfigured(idServer) : false,
    };
  } catch (e) {
    return {
      ok: false,
      error: e?.message || String(e),
      exe: rustdeskExePath(),
      rustdeskId: '',
    };
  }
}

async function applyServerAndOnline({ idServer, key, relayServer, allowElevate = true }) {
  const exe = await ensureInstalled();
  writeConfigFiles({ idServer, key, relayServer });
  if (!isOurServerConfigured(idServer)) {
    throw new Error('rustdesk_config_write_failed');
  }

  const marker = path.join(configDir(), '.sf-id-server-ok');
  const needsElevate =
    allowElevate && (!fs.existsSync(marker) || lastLogSaysPublicServer());

  if (needsElevate) {
    const b64 = buildConfigBase64({ idServer, key, relayServer });
    // Uma só elevação: --config (sem --install-service — causa hangs/UAC extra)
    try {
      await runElevatedArgs(exe, [['--config', b64]], 90000);
    } catch (e) {
      // TOML já escrito; continuar se o ficheiro estiver ok
      if (!isOurServerConfigured(idServer)) {
        throw new Error(
          e?.message ||
            'rustdesk_admin_required: aceite o UAC para configurar o servidor desta instalacao',
        );
      }
    }
    writeConfigFiles({ idServer, key, relayServer });
    try {
      fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
    } catch {
      /* ignore */
    }
  }

  startAgent(exe);

  let rustdeskId = '';
  for (let i = 0; i < 8; i++) {
    await sleep(1200);
    if (!isOurServerConfigured(idServer)) {
      writeConfigFiles({ idServer, key, relayServer });
    }
    rustdeskId = await getRustdeskId(exe);
    if (rustdeskId && (lastLogUsesOurServer(idServer) || i >= 5)) break;
  }

  if (!isOurServerConfigured(idServer)) {
    throw new Error('rustdesk_config_lost');
  }
  return { exe, rustdeskId };
}

async function setSessionPassword(exe, password) {
  const pwd = String(password || '').trim();
  if (!pwd) throw new Error('missing_password');

  // Caminho principal: TOML em claro (o RustDesk faz hash ao arrancar).
  // O CLI --password falha em muitos installs per-user com
  // "Installation and administrative privileges required!" — não pode ser obrigatório.
  writePermanentPasswordPlain(pwd);

  const exeLit = exe.replace(/'/g, "''");
  const pwdLit = pwd.replace(/'/g, "''");
  const ps = `
$exe = '${exeLit}'
$pwd = '${pwdLit}'
$ErrorActionPreference = 'SilentlyContinue'
try { Start-Service -Name 'RustDesk' } catch {}
Start-Sleep -Seconds 1
# Tenta CLI com UAC próprio (best-effort). Nunca throw — TOML já tem a senha.
try {
  Start-Process -FilePath $exe -ArgumentList @('--password', $pwd) -Verb RunAs -Wait -WindowStyle Hidden
} catch {}
try { Restart-Service -Name 'RustDesk' -Force } catch { try { Start-Service -Name 'RustDesk' } catch {} }
`;
  try {
    await runElevatedScript(ps, 100000);
  } catch {
    // UAC cancelado: seguimos com TOML + restart do tray
  }

  await killRustdesk();
  await sleep(500);
  startAgent(exe);
  await sleep(2500);

  // Reafirma TOML (o agent pode ter reescrito options)
  writePermanentPasswordPlain(pwd);

  if (!permanentPasswordConfigured()) {
    throw new Error(
      'rustdesk_password_not_saved: não foi possível gravar a senha do RustDesk',
    );
  }
  return true;
}

async function connectToHost(hostId, password, serverOpts) {
  const raw = String(hostId || '').trim();
  const id = raw.split(/[/@]/)[0].replace(/\D/g, '');
  if (!id || id.length < 6) throw new Error('missing_host_id');

  let exe = installedClientPath();
  if (!exe) exe = await ensureInstalled();

  if (serverOpts?.idServer && serverOpts?.key) {
    writeConfigFiles(serverOpts);
    if (!isOurServerConfigured(serverOpts.idServer)) {
      await applyServerAndOnline({ ...serverOpts, allowElevate: true });
      exe = installedClientPath() || exe;
    } else {
      // Reinicia o agent para aplicar force-always-relay / chave sem limpar confirm.
      await killRustdesk();
      await sleep(600);
      startAgent(exe);
    }
    // Espera o mediator Castino — --connect cedo demais = "tente mais tarde".
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      if (lastLogUsesOurServer(serverOpts.idServer)) break;
    }
  }

  const pwd = String(password || '').trim();
  if (!pwd) throw new Error('missing_session_password');

  startAgent(exe);
  await sleep(800);

  spawn(exe, ['--connect', id, '--password', pwd], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  }).unref();

  for (let i = 0; i < 12; i++) {
    await sleep(1000);
    if (lastLogConnectFailed()) {
      throw new Error(
        'rustdesk_connect_failed: falha ao ligar (ID offline/inexistente ou senha). Actualize o Desktop nos dois PCs; no host aceite o UAC ao preparar.',
      );
    }
  }
  return true;
}

async function prepareHost({ idServer, key, relayServer, password }) {
  const { exe, rustdeskId } = await applyServerAndOnline({
    idServer,
    key,
    relayServer,
    allowElevate: true,
  });
  if (!rustdeskId) throw new Error('rustdesk_id_unavailable');

  startAgent(exe);
  await sleep(1500);
  await setSessionPassword(exe, password);
  writeConfigFiles({ idServer, key, relayServer });
  writePermanentPasswordPlain(password);
  startAgent(exe);
  await sleep(2000);

  if (!permanentPasswordConfigured()) {
    throw new Error('rustdesk_password_not_saved');
  }

  const id2 = (await getRustdeskId(exe)) || rustdeskId;
  return { rustdeskId: id2, exe };
}

async function endRemoteSession() {
  try {
    const exe = installedClientPath();
    if (!exe) return false;
    // Não elevar no end — evita UAC/freeze ao encerrar. Roda sem admin (best-effort).
    const junk = crypto.randomBytes(8).toString('hex');
    await runExe(exe, ['--password', junk], { timeoutMs: 8000 });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  rustdeskExePath,
  bundledInstallerPath,
  installedClientPath,
  ensureCustomServer: writeConfigFiles,
  configureAndGetId,
  prepareHost,
  connectToHost,
  endRemoteSession,
  getRustdeskId,
  killRustdesk,
  isOurServerConfigured,
};
