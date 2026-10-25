const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  shell,
  session,
  screen,
  nativeImage,
  Tray,
  Menu,
  dialog,
  safeStorage,
  net,
} = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');
const { startLocalStream, stopLocalStream } = require('./local-stream');
const { startGameAudioCapture, startSystemAudioCapture, stopGameAudioCapture } = require('./game-audio-capture');
const remoteRustdesk = require('./remote-rustdesk');
const matchConnect = require('./match-connect');
const matchTunnel = require('./match-tunnel');
const matchHistory = require('./match-history');
const matchPacks = require('./match-packs');
const matchServerMods = require('./match-server-mods');
const cs2Gsi = require('./cs2-gsi');

// Antes de app.ready — reduz ducking/pausas de áudio ao capturar ecrã no Windows
try {
  app.commandLine.appendSwitch(
    'disable-features',
    'HardwareMediaKeyHandling,DocumentPictureInPictureAPI,AudioServiceSandboxWin',
  );
  // Evita que o Windows “Communications” baixe o volume de outras apps (ducking)
  app.commandLine.appendSwitch('disable-audio-output-resampler');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
} catch {
  /* ignore */
}

const isDevFlag = process.argv.includes('--dev');
const useProdUserData = process.argv.includes('--prod-userdata');
if (isDevFlag && !useProdUserData) {
  try {
    const dir = path.join(app.getPath('appData'), 'SteamFarm-Comunidade-localdev');
    fs.mkdirSync(dir, { recursive: true });
    app.setPath('userData', dir);
    console.log('[dev] userData isolado:', dir);
  } catch (err) {
    console.warn('[dev] userData isolado falhou:', err?.message || err);
  }
}
if (useProdUserData) {
  try {
    const dir = path.join(app.getPath('appData'), '@steamfarm', 'desktop');
    fs.mkdirSync(dir, { recursive: true });
    app.setPath('userData', dir);
    console.log('[dev] userData PROD (instalado):', dir);
  } catch (err) {
    console.warn('[dev] userData prod falhou:', err?.message || err);
  }
}
const isDev = isDevFlag || !app.isPackaged;

// application-loopback faz spawn sem .on('error') — ENOENT derrubava o main process e mutava a call
process.on('uncaughtException', (err) => {
  const msg = String(err?.message || err || '');
  const stack = String(err?.stack || '');
  if (
    /ENOENT/i.test(msg) &&
    (/ProcessList\.exe|ApplicationLoopback\.exe/i.test(msg) ||
      /application-loopback/i.test(stack))
  ) {
    console.warn('[guard] loopback spawn ignored:', msg);
    return;
  }
  console.error('[uncaughtException]', err);
});

process.on('unhandledRejection', (reason) => {
  const msg = String(reason?.message || reason || '');
  if (/ProcessList\.exe|ApplicationLoopback\.exe|ENOENT/i.test(msg)) {
    console.warn('[guard] loopback rejection ignored:', msg);
    return;
  }
  console.warn('[unhandledRejection]', reason);
});

function resolveServerUrl() {
  const fromEnv = (
    process.env.SF_COMMUNITY_URL ||
    process.env.SteamFarm_URL ||
    process.env.SteamFarm_MEETING_URL ||
    ''
  ).trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  try {
    const raw = fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8');
    const s = JSON.parse(raw);
    if (s?.communityUrl) return String(s.communityUrl).replace(/\/$/, '');
  } catch {
    /* ignore */
  }
  return (app.isPackaged ? 'https://chat.example.com' : 'http://localhost:5174').replace(
    /\/$/,
    '',
  );
}

const SERVER_URL = resolveServerUrl();
console.log('[desktop] SERVER_URL', SERVER_URL, 'packaged', app.isPackaged, 'dev', isDev);
const UPDATE_FEED_URL = (
  process.env.SF_DESKTOP_UPDATE_URL ||
  `${SERVER_URL}/desktop/`
).replace(/\/?$/, '/');
const PARTITION = 'persist:steamfarm-react';

/** @type {import('electron-updater').AppUpdater | null} */
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch {
  /* ausente em alguns ambientes de dev */
}

let updateReady = false;
let updateDownloading = false;
let updatePromptOpen = false;
/** @type {{ version?: string } | null} */
let pendingUpdateInfo = null;
let lastFocusCheckAt = 0;

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
let quitting = false;
let shareAudioMode = 'off';
let shareCapturePrefs = { quality: '720', fps: 30 };
/** @type {BrowserWindow | null} */
let pickerWin = null;
/** @type {{ resolve: (id: string) => void, reject: (e: Error) => void, sources: any[] } | null} */
let pickerPending = null;
/** @type {any} */
let lastChosenCaptureSource = null;
/** @type {any} */
let lastRtmpCapture = null;

function notifyRendererLeaving() {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sf:leaving');
    }
  } catch {
    /* ignore */
  }
}

function broadcastUpdateStatus() {
  const payload = {
    ready: updateReady,
    downloading: updateDownloading,
    version: pendingUpdateInfo?.version || '',
    available: updateReady || updateDownloading,
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sf:update-status', payload);
  }
}

function prepareUpdateTempDir(preferredDir) {
  // NSIS --updated extrai para %TEMP% e faz rename atómico. Se a app está noutro
  // disco e o TEMP do sistema está cheio, o update desinstala e falha a reinstalar.
  try {
    if (preferredDir) {
      const alt = path.join(preferredDir, '.sf-update-temp');
      fs.mkdirSync(alt, { recursive: true });
      process.env.TEMP = alt;
      process.env.TMP = alt;
      return { ok: true, temp: alt, reason: 'user_pick' };
    }
    const instDir = path.dirname(process.execPath);
    const instRoot = path.parse(instDir).root.toLowerCase();
    const tempRoot = path.parse(app.getPath('temp')).root.toLowerCase();
    if (instRoot && tempRoot && instRoot !== tempRoot) {
      const alt = path.join(instDir, '.sf-update-temp');
      fs.mkdirSync(alt, { recursive: true });
      process.env.TEMP = alt;
      process.env.TMP = alt;
      return { ok: true, temp: alt, reason: 'install_drive' };
    }
  } catch {
    /* ignore */
  }
  return { ok: true, temp: app.getPath('temp'), reason: 'default' };
}

function diskFreeBytes(dirPath) {
  try {
    const { execFileSync } = require('child_process');
    const drive = path.parse(dirPath).root.replace(/\\/g, '');
    const letter = drive.replace(':', '');
    if (!letter) return null;
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(Get-PSDrive -Name '${letter}').Free`],
      { windowsHide: true, timeout: 8000, encoding: 'utf8' },
    );
    const n = Number(String(out).trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** ~1.2 GB livres no disco do TEMP (extract + cópia atómica do NSIS). */
const UPDATE_TEMP_NEED_BYTES = 1200 * 1024 * 1024;

async function ensureUpdateTempWithSpace(parent) {
  let prep = prepareUpdateTempDir();
  let free = diskFreeBytes(prep.temp);
  if (free == null || free >= UPDATE_TEMP_NEED_BYTES) return { ok: true, prep, free };

  const freeGb = (free / (1024 * 1024 * 1024)).toFixed(2);
  const drive = path.parse(prep.temp).root;
  const { response } = await dialog.showMessageBox(parent, {
    type: 'warning',
    title: currentBrandName(),
    message: 'Sem espaço em disco para atualizar',
    detail:
      `O instalador precisa de ~1,5 GB livres no disco temporário ${drive} (agora ~${freeGb} GB).\n\n` +
      'Podes libertar espaço nesse disco ou escolher outra pasta noutro disco com espaço livre.',
    buttons: ['Escolher pasta…', 'Cancelar'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return { ok: false, reason: 'disk_full' };

  const pick = await dialog.showOpenDialog(parent, {
    title: 'Pasta temporária para a atualização',
    message: 'Escolhe uma pasta num disco com pelo menos ~1,5 GB livres.',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (pick.canceled || !pick.filePaths?.[0]) return { ok: false, reason: 'cancelled' };

  prep = prepareUpdateTempDir(pick.filePaths[0]);
  free = diskFreeBytes(prep.temp);
  if (free != null && free < UPDATE_TEMP_NEED_BYTES) {
    const gb = (free / (1024 * 1024 * 1024)).toFixed(2);
    await dialog.showMessageBox(parent, {
      type: 'warning',
      title: currentBrandName(),
      message: 'Essa pasta também não tem espaço suficiente',
      detail:
        `Disco ${path.parse(prep.temp).root} tem ~${gb} GB livres.\n` +
        'Escolhe outro disco ou liberta espaço e tenta de novo.',
      buttons: ['OK'],
      noLink: true,
    });
    return { ok: false, reason: 'disk_full' };
  }
  return { ok: true, prep, free };
}

async function promptInstallUpdate(info) {
  if (!autoUpdater || updatePromptOpen) return { ok: false, reason: 'busy' };
  if (!updateReady) return { ok: false, reason: 'not_ready' };
  updatePromptOpen = true;
  try {
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const version = info?.version || pendingUpdateInfo?.version || '';

    const space = await ensureUpdateTempWithSpace(parent);
    if (!space.ok) return { ok: false, reason: space.reason || 'disk_full' };

    const { response } = await dialog.showMessageBox(parent, {
      type: 'info',
      title: currentBrandName(),
      message: 'Nova versão disponível',
      detail: version
        ? `A versão ${version} foi baixada. Reinicie o app para atualizar.`
        : 'Uma nova versão foi baixada. Reinicie o app para atualizar.',
      buttons: ['Reiniciar agora', 'Agora não'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) {
      quitting = true;
      // Reaplica TEMP/TMP (pode ter sido escolhido pelo utilizador)
      if (space.prep?.temp) {
        process.env.TEMP = space.prep.temp;
        process.env.TMP = space.prep.temp;
      } else {
        prepareUpdateTempDir();
      }
      autoUpdater.quitAndInstall(true, true);
      return { ok: true };
    }
    return { ok: false, reason: 'deferred' };
  } finally {
    updatePromptOpen = false;
  }
}

function checkForUpdatesNow() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.checkForUpdates().catch(() => null);
}

async function showAboutDialog() {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const version = app.getVersion();
  const updateLine = updateReady
    ? `Atualização pronta${pendingUpdateInfo?.version ? ` (${pendingUpdateInfo.version})` : ''}.`
    : updateDownloading
      ? 'Baixando atualização…'
      : 'Nenhuma atualização pendente.';
  const { response } = await dialog.showMessageBox(parent, {
    type: 'info',
    title: 'Sobre',
    message: currentBrandName(),
    detail: `Versão ${version}\n${SERVER_URL}\n\n${updateLine}`,
    buttons: updateReady
      ? ['Instalar atualização', 'Verificar novamente', 'OK']
      : ['Verificar atualizações', 'OK'],
    defaultId: updateReady ? 2 : 1,
    cancelId: updateReady ? 2 : 1,
    noLink: true,
    icon: windowIcon(),
  });
  if (updateReady) {
    if (response === 0) {
      await promptInstallUpdate(pendingUpdateInfo);
    } else if (response === 1) {
      await checkForUpdatesManual(true);
    }
  } else if (response === 0) {
    await checkForUpdatesManual(true);
  }
}

async function checkForUpdatesManual(fromAbout = false) {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!autoUpdater || !app.isPackaged) {
    if (!fromAbout) {
      await dialog.showMessageBox(parent, {
        type: 'info',
        title: 'Atualizações',
        message: 'Checagem de atualização disponível só no app instalado.',
        buttons: ['OK'],
        noLink: true,
      });
    }
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const ver = result?.updateInfo?.version || '';
    if (updateReady) {
      await promptInstallUpdate(pendingUpdateInfo || result?.updateInfo || null);
      return;
    }
    await dialog.showMessageBox(parent, {
      type: 'info',
      title: 'Atualizações',
      message: ver && ver !== app.getVersion()
        ? `Nova versão encontrada: ${ver}`
        : 'Você já está na versão mais recente.',
      detail: ver && ver !== app.getVersion()
        ? 'O download começa automaticamente. Avisaremos quando estiver pronto para instalar.'
        : `Versão atual: ${app.getVersion()}`,
      buttons: ['OK'],
      noLink: true,
    });
  } catch (err) {
    await dialog.showMessageBox(parent, {
      type: 'warning',
      title: 'Atualizações',
      message: 'Não foi possível verificar atualizações.',
      detail: `${err instanceof Error ? err.message : String(err)}\n\nFeed: ${UPDATE_FEED_URL}`,
      buttons: ['OK'],
      noLink: true,
    });
  }
}

/** Menu mínimo (sem File/Edit/View): Sobre + atualizações. Também no tray. */
function buildAppMenuTemplate() {
  return [
    {
      label: currentBrandShort(),
      submenu: [
        { label: 'Sobre…', click: () => void showAboutDialog() },
        { label: 'Verificar atualizações…', click: () => void checkForUpdatesManual(false) },
        { type: 'separator' },
        {
          label: 'Sair',
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ],
    },
  ];
}

function setupAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate()));
}

function setupAutoUpdate() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.forceDevUpdateConfig = false;
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: UPDATE_FEED_URL });
  } catch {
    /* app-update.yml do build ainda vale como fallback */
  }
  autoUpdater.on('error', (err) => {
    try {
      console.warn('[autoUpdater]', err?.message || err);
    } catch {
      /* ignore */
    }
  });
  autoUpdater.on('update-available', (info) => {
    updateDownloading = true;
    pendingUpdateInfo = info || null;
    broadcastUpdateStatus();
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = true;
    updateDownloading = false;
    pendingUpdateInfo = info || pendingUpdateInfo;
    refreshTrayMenu();
    broadcastUpdateStatus();
  });
  // Checa cedo no boot + periódico
  setTimeout(checkForUpdatesNow, 3_000);
  setInterval(checkForUpdatesNow, 4 * 60 * 60 * 1000);
}

function maybeCheckOnFocus() {
  const now = Date.now();
  if (now - lastFocusCheckAt < 5 * 60 * 1000) return;
  lastFocusCheckAt = now;
  checkForUpdatesNow();
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function credsPath() {
  return path.join(app.getPath('userData'), 'creds.bin');
}
function credsFallbackPath() {
  return path.join(app.getPath('userData'), 'creds.fallback.json');
}

function loadSettings() {
  try {
    return {
      minimizeToTray: true,
      openAtLogin: false,
      ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')),
    };
  } catch {
    return { minimizeToTray: true, openAtLogin: false };
  }
}

function saveSettings(partial) {
  const next = { ...loadSettings(), ...partial };
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  try {
    app.setLoginItemSettings({
      openAtLogin: !!next.openAtLogin,
      path: process.execPath,
      args: [],
      enabled: true,
    });
  } catch {
    /* ignore */
  }
  return next;
}

function brandCacheDir() {
  const dir = path.join(app.getPath('userData'), 'brand');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return dir;
}

function currentBrandName() {
  const s = loadSettings();
  return (s.brandName || '').trim() || 'SteamFarm Comunidade';
}

function currentBrandShort() {
  const s = loadSettings();
  return (s.brandShortName || '').trim() || currentBrandName().split(/\s+/)[0] || 'App';
}

function absoluteBrandUrl(rel) {
  const u = String(rel || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('/')) return `${SERVER_URL}${u}`;
  return `${SERVER_URL}/${u}`;
}

function detectImageKind(buf) {
  if (!buf || buf.length < 8) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  // ICO: 00 00 01 00
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'ico';
  // RIFF WEBP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return '';
}

function isValidImageFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return false;
    const buf = fs.readFileSync(filePath);
    const kind = detectImageKind(buf);
    if (!kind) return false;
    const img = nativeImage.createFromBuffer(buf);
    return !!(img && !img.isEmpty());
  } catch {
    return false;
  }
}

/** Empacota PNG (ideal 256²) em .ico real — Windows .lnk exige ICO, não PNG. */
function writePngAsIco(pngBuf, destPath) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0; // 256
  entry[1] = 0;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12);
  fs.writeFileSync(destPath, Buffer.concat([header, entry, pngBuf]));
}

function normalizeBrandIconFiles(pngPath, icoPath) {
  let pngOk = false;
  let icoOk = false;

  // Se "ico" for PNG/JPG baixado por engano, vira PNG de trabalho
  if (fs.existsSync(icoPath)) {
    try {
      const buf = fs.readFileSync(icoPath);
      const kind = detectImageKind(buf);
      if (kind === 'ico') {
        const img = nativeImage.createFromBuffer(buf);
        icoOk = !!(img && !img.isEmpty());
      } else if (kind === 'png' || kind === 'jpg' || kind === 'webp') {
        fs.writeFileSync(pngPath, buf);
        try {
          fs.unlinkSync(icoPath);
        } catch {
          /* ignore */
        }
      } else {
        try {
          fs.unlinkSync(icoPath);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (fs.existsSync(pngPath)) {
    try {
      const buf = fs.readFileSync(pngPath);
      const kind = detectImageKind(buf);
      let img = nativeImage.createFromBuffer(buf);
      if ((!img || img.isEmpty()) && kind) {
        img = nativeImage.createFromPath(pngPath);
      }
      if (img && !img.isEmpty()) {
        const size = img.getSize();
        const side = Math.max(size.width || 0, size.height || 0);
        const target = side >= 256 ? 256 : side >= 128 ? 128 : side >= 64 ? 64 : 32;
        const resized = img.resize({ width: target, height: target, quality: 'best' });
        const out = (resized.isEmpty() ? img : resized).toPNG();
        fs.writeFileSync(pngPath, out);
        pngOk = true;
        if (!icoOk) {
          writePngAsIco(out, icoPath);
          icoOk = isValidImageFile(icoPath);
        }
      } else {
        try {
          fs.unlinkSync(pngPath);
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      console.warn('[brand] normalize png failed', e?.message || e);
    }
  }

  // Fallback: gerar PNG a partir de ICO válido
  if (!pngOk && icoOk && fs.existsSync(icoPath)) {
    try {
      const img = nativeImage.createFromPath(icoPath);
      if (img && !img.isEmpty()) {
        fs.writeFileSync(pngPath, img.resize({ width: 256, height: 256, quality: 'best' }).toPNG());
        pngOk = true;
      }
    } catch {
      /* ignore */
    }
  }

  return {
    png: pngOk ? pngPath : '',
    ico: icoOk && fs.existsSync(icoPath) ? icoPath : '',
  };
}

function bundledIconPng() {
  const p = path.join(__dirname, 'assets', 'icon.png');
  return fs.existsSync(p) ? p : '';
}

function bundledIconIco() {
  const p = path.join(__dirname, 'assets', 'icon.ico');
  return fs.existsSync(p) ? p : '';
}

/** Copia ícone do asar para userData — .lnk do Windows NÃO lê arquivos dentro de app.asar. */
function materializeBundledIco() {
  const dest = path.join(brandCacheDir(), 'bundled-fallback.ico');
  try {
    const src = bundledIconIco();
    if (!src) return '';
    // Sempre regrava se faltando/ inválido (asar → disco)
    if (!isValidImageFile(dest) || detectImageKind(fs.readFileSync(dest)) !== 'ico') {
      fs.copyFileSync(src, dest);
    }
    if (detectImageKind(fs.readFileSync(dest)) === 'ico') return dest;
  } catch (e) {
    console.warn('[brand] materialize ico failed', e?.message || e);
  }
  return '';
}

function windowsSafeIconPath(preferredIco) {
  // 1) ICO da marca em userData
  if (preferredIco && fs.existsSync(preferredIco)) {
    try {
      if (detectImageKind(fs.readFileSync(preferredIco)) === 'ico') {
        // Recusar path dentro de asar
        if (!String(preferredIco).includes(`${path.sep}app.asar${path.sep}`)) {
          return preferredIco;
        }
      }
    } catch {
      /* ignore */
    }
  }
  const s = loadSettings();
  if (s.brandIconIco && fs.existsSync(s.brandIconIco)) {
    try {
      if (
        detectImageKind(fs.readFileSync(s.brandIconIco)) === 'ico' &&
        !String(s.brandIconIco).includes(`${path.sep}app.asar${path.sep}`)
      ) {
        return s.brandIconIco;
      }
    } catch {
      /* ignore */
    }
  }
  // 2) Extrair ICO do pacote para disco
  const bundled = materializeBundledIco();
  if (bundled) return bundled;
  // 3) Ícone embutido no próprio .exe (sempre legível pelo Explorer)
  return process.execPath;
}

function downloadToFile(url, dest) {
  return new Promise((resolve, reject) => {
    try {
      const mod = url.startsWith('https:') ? https : http;
      const req = mod.get(
        url,
        {
          timeout: 20000,
          headers: { Accept: 'image/*,*/*', 'User-Agent': 'RallyDesk-Desktop' },
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const next = res.headers.location.startsWith('http')
              ? res.headers.location
              : `${SERVER_URL}${res.headers.location}`;
            res.resume();
            downloadToFile(next, dest).then(resolve, reject);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              const buf = Buffer.concat(chunks);
              if (!detectImageKind(buf)) {
                reject(new Error('not_an_image'));
                return;
              }
              fs.writeFileSync(dest, buf);
              resolve(dest);
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });
    } catch (e) {
      reject(e);
    }
  });
}

function safeShortcutFileName(name) {
  return String(name || 'App')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'App';
}

function applyBrandToUi(name) {
  const n = (name || '').trim() || 'SteamFarm Comunidade';
  try {
    app.setName(n);
  } catch {
    /* ignore */
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(n);
    const icon = windowIcon();
    if (icon) {
      try {
        mainWindow.setIcon(icon);
      } catch {
        /* ignore */
      }
    }
  }
  if (tray) {
    try {
      tray.setToolTip(n);
      const tIcon = trayIcon();
      if (tIcon && !tIcon.isEmpty()) tray.setImage(tIcon);
    } catch {
      /* ignore */
    }
  }
  try {
    setupAppMenu();
  } catch {
    /* ignore */
  }
  try {
    refreshTrayMenu();
  } catch {
    /* ignore */
  }
}

/** Atualiza atalhos .lnk (ícone ICO em disco + renomeia para a marca). */
function updateWindowsShortcuts(productName, icoPath) {
  if (process.platform !== 'win32') return;
  const exe = process.execPath;
  const name = safeShortcutFileName(productName);
  const namePs = name.replace(/'/g, "''");
  // Nunca apontar para app.asar — Explorer não lê e mostra folha em branco
  const safeIco = windowsSafeIconPath(icoPath);
  const ico = String(safeIco || exe).replace(/'/g, "''");
  const exeEsc = exe.replace(/'/g, "''");
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$W = New-Object -ComObject WScript.Shell
$targets = @(
  [IO.Path]::Combine($env:APPDATA, 'Microsoft\\Windows\\Start Menu\\Programs'),
  [Environment]::GetFolderPath('Desktop'),
  [IO.Path]::Combine($env:APPDATA, 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar')
)
$icoPath = '${ico}'
if (-not (Test-Path -LiteralPath $icoPath)) { $icoPath = '${exeEsc}' }
foreach ($dir in $targets) {
  if (-not (Test-Path $dir)) { continue }
  Get-ChildItem -Path $dir -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $sc = $W.CreateShortcut($_.FullName)
      if ($sc.TargetPath -and ($sc.TargetPath -ieq '${exeEsc}')) {
        $sc.Description = '${namePs}'
        $sc.IconLocation = "$icoPath,0"
        $sc.Save()
        $dest = Join-Path $_.DirectoryName ('${namePs}' + '.lnk')
        if ($_.FullName -ne $dest) {
          if (Test-Path $dest) { Remove-Item -LiteralPath $dest -Force }
          Rename-Item -LiteralPath $_.FullName -NewName ('${namePs}' + '.lnk') -Force
        }
      }
    } catch {}
  }
}
`;
  const scriptPath = path.join(brandCacheDir(), 'update-shortcuts.ps1');
  try {
    fs.writeFileSync(scriptPath, ps, 'utf8');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true, timeout: 20000 },
      () => undefined,
    );
  } catch {
    /* ignore */
  }
}

async function syncBrandFromServer() {
  try {
    const res = await apiFetch('/api/community/brand');
    const d = res?.data || {};
    if (!d || d.ok === false) return;
    const name = String(d.name || '').trim() || 'SteamFarm Comunidade';
    const shortName = String(d.short_name || '').trim() || 'SteamFarm';
    const revision = Number(d.revision) || 0;
    const prev = loadSettings();
    const dir = brandCacheDir();
    const pngPath = path.join(dir, 'app-icon.png');
    const icoPath = path.join(dir, 'app-icon.ico');
    const tmpPng = path.join(dir, 'download-icon.bin');
    const tmpIco = path.join(dir, 'download-ico.bin');

    const iconUrl = absoluteBrandUrl(d.app_icon_url || d.logo_url || d.favicon_url || '');
    const icoUrl = absoluteBrandUrl(d.app_ico_url || '');
    const needRefresh =
      revision !== prev.brandRevision ||
      !isValidImageFile(pngPath) ||
      !isValidImageFile(icoPath);

    if (iconUrl && needRefresh) {
      try {
        await downloadToFile(iconUrl, tmpPng);
        fs.copyFileSync(tmpPng, pngPath);
      } catch (e) {
        console.warn('[brand] icon download failed', e?.message || e);
      }
    }
    if (icoUrl && needRefresh) {
      try {
        await downloadToFile(icoUrl, tmpIco);
        // Pode ser PNG disfarçado — normalize trata
        fs.copyFileSync(tmpIco, icoPath);
      } catch (e) {
        console.warn('[brand] ico download failed', e?.message || e);
      }
    }

    let normalized = normalizeBrandIconFiles(pngPath, icoPath);
    if (!normalized.png && bundledIconPng()) {
      try {
        fs.copyFileSync(bundledIconPng(), pngPath);
        normalized = normalizeBrandIconFiles(pngPath, icoPath);
      } catch {
        /* ignore */
      }
    }
    if (!normalized.ico) {
      // Materializar no userData — nunca persistir path de app.asar (Explorer não lê)
      normalized.ico = materializeBundledIco();
    } else if (String(normalized.ico).includes(`${path.sep}app.asar${path.sep}`)) {
      const materialized = materializeBundledIco();
      if (materialized) normalized.ico = materialized;
    }

    saveSettings({
      brandName: name,
      brandShortName: shortName,
      brandRevision: revision,
      brandIconPng: normalized.png || '',
      brandIconIco: normalized.ico || '',
    });
    applyBrandToUi(name);
    updateWindowsShortcuts(name, normalized.ico || '');
  } catch (e) {
    console.warn('[brand] sync failed', e?.message || e);
    applyBrandToUi(currentBrandName());
  }
}

function readCreds() {
  const p = credsPath();
  if (safeStorage.isEncryptionAvailable() && fs.existsSync(p)) {
    try {
      const data = JSON.parse(safeStorage.decryptString(fs.readFileSync(p)));
      if (data?.username && data?.password) return data;
    } catch {
      /* fallback */
    }
  }
  // Versões antigas gravavam a senha em creds.fallback.json só em base64 (texto puro,
  // na prática). Não lemos mais esse arquivo: apagamos e pedimos login de novo.
  const fb = credsFallbackPath();
  if (fs.existsSync(fb)) {
    try {
      fs.unlinkSync(fb);
    } catch {
      /* ignore */
    }
  }
  return null;
}

function saveCreds(username, password) {
  if (!username || !password) return { ok: false, reason: 'missing_fields' };
  // Sem safeStorage (DPAPI indisponível) a senha não é gravada de jeito nenhum.
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, reason: 'encryption_unavailable' };
  try {
    fs.writeFileSync(credsPath(), safeStorage.encryptString(JSON.stringify({ username, password })));
    return { ok: true, method: 'safeStorage' };
  } catch {
    return { ok: false, reason: 'write_failed' };
  }
}

function clearCreds() {
  for (const p of [credsPath(), credsFallbackPath()]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
  return { ok: true };
}

function appIconPath() {
  const s = loadSettings();
  // Preferir PNG válido (nativeImage); ICO falso (PNG renomeado) quebra no Windows
  if (s.brandIconPng && isValidImageFile(s.brandIconPng)) return s.brandIconPng;
  if (s.brandIconIco && isValidImageFile(s.brandIconIco)) return s.brandIconIco;
  const png = path.join(__dirname, 'assets', 'icon.png');
  const ico = path.join(__dirname, 'assets', 'icon.ico');
  if (fs.existsSync(png)) return png;
  if (fs.existsSync(ico)) return ico;
  return undefined;
}

function windowIcon() {
  const p = appIconPath();
  if (!p) return undefined;
  try {
    const buf = fs.readFileSync(p);
    let img = nativeImage.createFromBuffer(buf);
    if (!img || img.isEmpty()) img = nativeImage.createFromPath(p);
    return img && !img.isEmpty() ? img : undefined;
  } catch {
    return undefined;
  }
}

/** Ícone pequeno para a bandeja — ICO/PNG 512px no Windows costuma sumir. */
function trayIcon() {
  const s = loadSettings();
  const candidates = [
    s.brandIconPng,
    s.brandIconIco,
    path.join(__dirname, 'assets', 'icon.png'),
    path.join(__dirname, 'assets', 'icon.ico'),
  ].filter(Boolean);
  let img = null;
  for (const p of candidates) {
    if (!isValidImageFile(p) && !fs.existsSync(p)) continue;
    try {
      const buf = fs.readFileSync(p);
      img = nativeImage.createFromBuffer(buf);
      if (!img || img.isEmpty()) img = nativeImage.createFromPath(p);
      if (img && !img.isEmpty()) break;
    } catch {
      img = null;
    }
    img = null;
  }
  if (!img || img.isEmpty()) {
    return nativeImage.createEmpty();
  }
  try {
    const sized = img.resize({ width: 16, height: 16, quality: 'best' });
    if (!sized.isEmpty()) return sized;
  } catch {
    /* fallback abaixo */
  }
  return img;
}

function communitySession() {
  return session.fromPartition(PARTITION);
}

/** Drop Chromium HTTP cache so chat.example.com HTML/JS não fica preso. */
async function refreshWebCache() {
  try {
    await communitySession().clearCache();
    console.log('[SF-VOICE]', new Date().toISOString().slice(11, 23), 'main:cache-cleared');
  } catch (err) {
    console.warn('[SF-VOICE] cache clear failed:', err?.message || err);
  }
}

function communityWindowBounds() {
  const { width, height, x, y } = screen.getPrimaryDisplay().workArea;
  const w = Math.max(1024, Math.floor(width * 0.92));
  const h = Math.max(680, Math.floor(height * 0.9));
  return {
    width: Math.min(w, width),
    height: Math.min(h, height),
    x: x + Math.floor((width - Math.min(w, width)) / 2),
    y: y + Math.floor((height - Math.min(h, height)) / 2),
  };
}

const PACK_API_ORIGINS = [
  'https://chat.example.com',
  'https://vps.example.com',
];

function apiOriginsFor(pathname) {
  const primary = String(SERVER_URL || '').replace(/\/$/, '');
  const extra =
    String(pathname || '').startsWith('/api/match-packs')
      ? PACK_API_ORIGINS
      : [];
  return [...new Set([primary, ...extra].filter(Boolean))];
}

function looksLikeJson(text) {
  const t = String(text || '').trim();
  return t.startsWith('{') || t.startsWith('[');
}

async function apiFetch(pathname, { method = 'GET', body } = {}) {
  const ses = communitySession();
  const headers = {
    Accept: 'application/json',
    'X-SteamFarm-Desktop': '1',
  };
  let payload;
  if (body != null) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let last = { status: 0, data: { ok: false, error: 'Resposta inválida do servidor' } };
  for (const origin of apiOriginsFor(pathname)) {
    const res = await ses.fetch(`${origin}${pathname}`, {
      method,
      headers,
      body: payload,
      redirect: 'manual',
    });
    const text = await res.text();
    if (res.status >= 300 && res.status < 400) {
      last = {
        status: res.status,
        data: { ok: false, error: `redirect_${res.status}`, raw: String(res.headers.get('location') || '') },
      };
      continue;
    }
    if (!looksLikeJson(text)) {
      last = {
        status: res.status,
        data: { ok: false, error: 'Resposta inválida do servidor', raw: text.slice(0, 200) },
      };
      continue;
    }
    try {
      return { status: res.status, data: text ? JSON.parse(text) : null };
    } catch {
      last = {
        status: res.status,
        data: { ok: false, error: 'Resposta inválida do servidor', raw: text.slice(0, 200) },
      };
    }
  }
  return last;
}

async function apiFetchBinary(pathname) {
  const ses = communitySession();
  let last = { status: 0, error: 'http_0', buffer: null };
  for (const origin of apiOriginsFor(pathname)) {
    const res = await ses.fetch(`${origin}${pathname}`, {
      method: 'GET',
      headers: {
        Accept: 'application/octet-stream',
        'X-SteamFarm-Desktop': '1',
      },
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      last = { status: res.status, error: `redirect_${res.status}`, buffer: null };
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      let error = `http_${res.status}`;
      try {
        const t = await res.text();
        if (looksLikeJson(t)) {
          const j = JSON.parse(t);
          if (j?.error) error = j.error;
        }
      } catch {
        /* ignore */
      }
      last = { status: res.status, error, buffer: null };
      continue;
    }
    const ab = await res.arrayBuffer();
    return { status: res.status, buffer: Buffer.from(ab) };
  }
  return last;
}

function loadAppUrl(pathname) {
  const ver = encodeURIComponent(app.getVersion() || '0');
  const join = pathname.includes('?') ? '&' : '?';
  const url = `${SERVER_URL}${pathname}${join}desktop=1&_app=${ver}`;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(url, { httpReferrer: SERVER_URL });
  }
}

/** Em --dev, espera o Vite/API antes do bootstrap (evita tela preta se o Electron subir primeiro). */
async function waitForDevServer(timeoutMs = 90000) {
  if (app.isPackaged || !isDev) return true;
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < timeoutMs) {
    attempt += 1;
    try {
      const res = await net.fetch(`${SERVER_URL}/`, { method: 'GET' });
      if (res.ok || res.status === 304) {
        console.log(`[desktop] Vite pronto em ${Date.now() - started}ms (${SERVER_URL})`);
        return true;
      }
    } catch {
      /* still booting */
    }
    if (attempt === 1 || attempt % 10 === 0) {
      console.log(`[desktop] Aguardando Vite em ${SERVER_URL}…`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn(`[desktop] Timeout aguardando ${SERVER_URL}`);
  return false;
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    return mainWindow;
  }
  const bounds = communityWindowBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 640,
    title: currentBrandName(),
    icon: windowIcon(),
    show: false,
    backgroundColor: '#0f1117',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      session: communitySession(),
      spellcheck: false,
    },
  });
  mainWindow.setMenuBarVisibility(true);
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
    mainWindow.focus();
  });
  let failReloadTries = 0;
  mainWindow.webContents.on('did-finish-load', () => {
    failReloadTries = 0;
    broadcastUpdateStatus();
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || !isDev || app.isPackaged) return;
    if (code === -3) return; // aborted
    console.warn('[desktop] did-fail-load', code, desc, url);
    if (failReloadTries >= 40) return;
    failReloadTries += 1;
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      console.log('[desktop] retry load após falha…', failReloadTries);
      mainWindow.webContents.reload();
    }, 800);
  });
  mainWindow.on('focus', () => maybeCheckOnFocus());
  mainWindow.on('show', () => maybeCheckOnFocus());
  mainWindow.on('close', (ev) => {
    const settings = loadSettings();
    if (!quitting && settings.minimizeToTray) {
      ev.preventDefault();
      // Só esconde na tray — mantém voz/LiveKit ativos
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    } else {
      // Encerramento real da janela (sem tray ou já em quitting)
      notifyRendererLeaving();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  attachNavigationGuard(mainWindow);
  return mainWindow;
}

function isLocalDevHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

function isAllowedUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === 'file:') return true;
    let server;
    try {
      server = new URL(SERVER_URL);
    } catch {
      server = null;
    }
    // Aceita 127.0.0.1 ↔ localhost no mesmo porto (Steam/OpenID às vezes troca)
    const sameLocalApp =
      !!server &&
      isLocalDevHost(u.hostname) &&
      isLocalDevHost(server.hostname) &&
      (u.port || (u.protocol === 'https:' ? '443' : '80')) ===
        (server.port || (server.protocol === 'https:' ? '443' : '80'));
    const knownAppOrigins = new Set(
      [SERVER_URL, 'https://chat.example.com', 'https://vps.example.com'].filter(Boolean),
    );
    if (knownAppOrigins.has(u.origin) || sameLocalApp) {
      const p = u.pathname;
      // /steam/link (OpenID start) NÃO — navegar na janela principal trava a SPA.
      // Callback só precisa no browser externo; CDN steamstatic já acima.
      const steamOk = p.startsWith('/steam/link/callback');
      return (
        p.startsWith('/comunidade') ||
        p.startsWith('/assistir/') ||
        p.startsWith('/api/') ||
        steamOk ||
        p.startsWith('/uploads/') ||
        p.startsWith('/maps/') ||
        p.startsWith('/static/') ||
        p.startsWith('/assets/') ||
        p === '/login' ||
        p === '/register' ||
        p === '/setup' ||
        p === '/recuperar' ||
        p.startsWith('/logout') ||
        p === '/'
      );
    }
    if (u.hostname.endsWith('livekit.cloud') || u.hostname.includes('livekit')) return true;
    if (u.origin === SERVER_URL.replace(/:\d+$/, '') + ':8443') return true;
    try {
      if (u.hostname === new URL(SERVER_URL).hostname && (u.port === '8443' || u.port === '7881')) {
        return true;
      }
    } catch {
      /* ignore */
    }
    if (
      u.hostname === 'cdn.jsdelivr.net' ||
      u.hostname === 'fonts.googleapis.com' ||
      u.hostname === 'fonts.gstatic.com'
    ) {
      return true;
    }
    if (
      u.hostname.endsWith('steamstatic.com') ||
      u.hostname === 'steam.tv'
    ) {
      // CDN / embeds OK. Login OpenID NÃO — abre no browser externo.
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isOAuthUrl(raw) {
  try {
    const h = new URL(raw).hostname;
    if (h === 'id.twitch.tv' || h === 'accounts.google.com' || h.endsWith('.google.com')) {
      return true;
    }
    // Steam OpenID — nunca dentro da janela principal (trava a SPA / voz)
    if (
      h.endsWith('steamcommunity.com') ||
      h.endsWith('steampowered.com') ||
      h === 'steamcommunity.com' ||
      h === 'steampowered.com'
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function openAuthExternal(url) {
  try {
    void shell.openExternal(url);
  } catch (err) {
    console.warn('[nav] openExternal failed:', err?.message || err);
  }
}

function isSteamOpenIdStartUrl(raw) {
  try {
    const u = new URL(raw);
    let server;
    try {
      server = new URL(SERVER_URL);
    } catch {
      return false;
    }
    const sameLocalApp =
      isLocalDevHost(u.hostname) &&
      isLocalDevHost(server.hostname) &&
      (u.port || (u.protocol === 'https:' ? '443' : '80')) ===
        (server.port || (server.protocol === 'https:' ? '443' : '80'));
    if (u.origin !== SERVER_URL && !sameLocalApp) return false;
    const p = u.pathname.replace(/\/$/, '') || '/';
    return p === '/steam/link';
  } catch {
    return false;
  }
}

/** Abre OpenID no browser externo sem descarregar a SPA (usa cookie da sessão na app). */
function openSteamLinkExternal(wc, nextHint) {
  const next =
    typeof nextHint === 'string' && nextHint.startsWith('/')
      ? nextHint
      : '/comunidade?desktop=1';
  const js = `(async()=>{try{
    const res=await fetch('/api/steam/link-url?next='+encodeURIComponent(${JSON.stringify(next)}),{credentials:'include',headers:{Accept:'application/json'}});
    const data=await res.json().catch(()=>null);
    if(data&&data.url&&window.sfDesktop&&typeof window.sfDesktop.openExternal==='function'){
      await window.sfDesktop.openExternal(data.url);
      return true;
    }
    return false;
  }catch(e){console.warn('[steam-link]',e);return false;}})()`;
  void wc.executeJavaScript(js).catch((err) => {
    console.warn('[nav] steam link external failed:', err?.message || err);
  });
}

function attachNavigationGuard(win) {
  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (isSteamOpenIdStartUrl(url)) {
      try {
        const next = new URL(url).searchParams.get('next') || '/comunidade?desktop=1';
        openSteamLinkExternal(wc, next);
      } catch {
        openSteamLinkExternal(wc);
      }
      return { action: 'deny' };
    }
    if (isOAuthUrl(url)) {
      openAuthExternal(url);
      return { action: 'deny' };
    }
    if (isAllowedUrl(url)) {
      return { action: 'allow' };
    }
    openAuthExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (isSteamOpenIdStartUrl(url)) {
      event.preventDefault();
      try {
        const next = new URL(url).searchParams.get('next') || '/comunidade?desktop=1';
        openSteamLinkExternal(wc, next);
      } catch {
        openSteamLinkExternal(wc);
      }
      return;
    }
    if (isOAuthUrl(url)) {
      event.preventDefault();
      openAuthExternal(url);
      return;
    }
    if (!isAllowedUrl(url)) {
      event.preventDefault();
      if (url.startsWith(SERVER_URL) && !url.includes('/comunidade') && !url.includes('/api/')) {
        wc.loadURL(`${SERVER_URL}/comunidade?desktop=1`);
        return;
      }
      openAuthExternal(url);
    }
  });
  wc.on('will-redirect', (event, url) => {
    try {
      if (isOAuthUrl(url)) {
        event.preventDefault();
        openAuthExternal(url);
        // Volta à comunidade se o /steam/link chegou a descarregar a SPA
        try {
          const cur = wc.getURL();
          if (!cur || !cur.includes('/comunidade')) {
            wc.loadURL(`${SERVER_URL}/comunidade?desktop=1`);
          }
        } catch {
          /* ignore */
        }
        return;
      }
      const u = new URL(url);
      if (u.origin === SERVER_URL) {
        const p = u.pathname;
        const farmOnly =
          p.startsWith('/conta') ||
          p.startsWith('/bots') ||
          p.startsWith('/carteira') ||
          p.startsWith('/painel') ||
          p.startsWith('/inventario') ||
          p.startsWith('/perfil') ||
          p.startsWith('/avisos') ||
          p.startsWith('/monitor') ||
          p.startsWith('/users') ||
          p.startsWith('/billing') ||
          p.startsWith('/whatsapp') ||
          p.startsWith('/status-steam');
        if (farmOnly) {
          event.preventDefault();
          wc.loadURL(`${SERVER_URL}/comunidade?desktop=1`);
        }
      }
    } catch {
      /* ignore */
    }
  });
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    loadAppUrl('/comunidade');
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  if (process.platform === 'win32') {
    mainWindow.moveTop();
    mainWindow.flashFrame(false);
  }
  maybeCheckOnFocus();
}

function buildTrayMenu() {
  const items = [
    { label: 'Abrir', click: () => focusMainWindow() },
    { type: 'separator' },
    { label: 'Sobre…', click: () => void showAboutDialog() },
    { label: 'Verificar atualizações…', click: () => void checkForUpdatesManual(false) },
  ];
  if (updateReady) {
    items.push({
      label: 'Instalar atualização…',
      click: () => void promptInstallUpdate(pendingUpdateInfo),
    });
  }
  items.push(
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  );
  return Menu.buildFromTemplate(items);
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
}

function ensureTray() {
  if (tray) return;
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip(currentBrandName());
    refreshTrayMenu();
    tray.on('double-click', () => focusMainWindow());
    // Clique esquerdo também abre o menu (no Win o direito às vezes passa despercebido)
    tray.on('click', (_ev, bounds) => {
      maybeCheckOnFocus();
      try {
        tray.popUpContextMenu(buildTrayMenu(), bounds);
      } catch {
        tray.popUpContextMenu(buildTrayMenu());
      }
    });
    tray.on('right-click', (_ev, bounds) => {
      try {
        tray.popUpContextMenu(buildTrayMenu(), bounds);
      } catch {
        tray.popUpContextMenu(buildTrayMenu());
      }
    });
  } catch (err) {
    console.warn('[tray] falhou ao criar:', err?.message || err);
    tray = null;
  }
}

async function bootstrapSession() {
  createMainWindow();
  const me = await apiFetch('/api/auth/status').catch(() => ({ status: 0, data: null }));
  if (me.status === 200 && me.data?.logged_in) {
    loadAppUrl('/comunidade');
    return;
  }
  // Compat: alguns payloads usam ok + user
  if (me.status === 200 && me.data?.ok && me.data?.user) {
    loadAppUrl('/comunidade');
    return;
  }
  const creds = readCreds();
  if (creds?.username && creds?.password) {
    const login = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: { username: creds.username, password: creds.password, desktop: true },
    });
    if ((login.status === 200 || login.status === 201) && (login.data?.ok || login.data?.user)) {
      loadAppUrl('/comunidade');
      return;
    }
  }
  loadAppUrl('/login');
}

function closePicker(result) {
  if (pickerPending) {
    const pending = pickerPending;
    pickerPending = null;
    if (result) pending.resolve(result);
    else pending.reject(new Error('cancelled'));
  }
  if (pickerWin && !pickerWin.isDestroyed()) {
    pickerWin.close();
  }
  pickerWin = null;
}

async function chooseCaptureSource() {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: false,
  });
  if (!sources.length) {
    throw new Error('Nenhuma tela/janela disponível');
  }
  if (sources.length === 1) {
    lastChosenCaptureSource = sources[0];
    return sources[0];
  }
  return new Promise((resolve, reject) => {
    if (pickerPending) {
      const old = pickerPending;
      pickerPending = null;
      old.reject(new Error('cancelled'));
    }
    if (pickerWin && !pickerWin.isDestroyed()) {
      pickerWin.destroy();
      pickerWin = null;
    }
    pickerPending = {
      resolve: (id) => {
        const found = sources.find((s) => s.id === id) || sources[0];
        lastChosenCaptureSource = found;
        resolve(found);
      },
      reject,
      sources: sources.map((s) => ({
        id: s.id,
        name: s.name,
        thumbnailDataUrl: s.thumbnail?.toDataURL?.() || '',
      })),
    };
    pickerWin = new BrowserWindow({
      width: 720,
      height: 520,
      minWidth: 480,
      minHeight: 360,
      parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
      // modal:true pausava o áudio WebRTC da janela principal no Windows
      modal: false,
      alwaysOnTop: true,
      resizable: true,
      title: 'Compartilhar tela',
      icon: windowIcon(),
      backgroundColor: '#0b0e13',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        session: communitySession(),
      },
    });
    pickerWin.loadFile(path.join(__dirname, 'renderer', 'picker.html'));
    pickerWin.on('closed', () => {
      pickerWin = null;
      if (pickerPending) {
        const pending = pickerPending;
        pickerPending = null;
        pending.reject(new Error('cancelled'));
      }
      notifyRestoreVoiceAudio('picker-closed');
    });
  });
}

function notifyRestoreVoiceAudio(reason) {
  console.log('[SF-VOICE]', new Date().toISOString().slice(11, 23), 'main:restore-voice', {
    reason: reason || 'unknown',
  });
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
        // getDisplayMedia / captura pode silenciar o webContents inteiro
        const wasMuted = mainWindow.webContents.isAudioMuted();
        mainWindow.webContents.setAudioMuted(false);
        mainWindow.webContents.setBackgroundThrottling(false);
        console.log('[SF-VOICE]', new Date().toISOString().slice(11, 23), 'main:webContents-unmute', {
          wasMuted,
          nowMuted: mainWindow.webContents.isAudioMuted(),
        });
        mainWindow.webContents.send('sf:restore-voice-audio', {
          reason: reason || 'unknown',
          wasAudioMuted: wasMuted,
        });
      }
      mainWindow.focus();
    }
  } catch (err) {
    console.warn('[SF-VOICE] restore send failed:', err?.message || err);
  }
  void unmuteDefaultSpeakers().then((r) => {
    console.log('[SF-VOICE]', new Date().toISOString().slice(11, 23), 'main:unmute-speakers', r || {});
  });
}

/** Enquanto partilha, o Chromium por vezes remuta o webContents — força unmute. */
let voiceUnmuteTimer = null;
let shareActive = false;
function startVoiceUnmuteWatch() {
  if (voiceUnmuteTimer) return;
  let ticks = 0;
  voiceUnmuteTimer = setInterval(() => {
    ticks += 1;
    try {
      if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents || mainWindow.webContents.isDestroyed()) {
        return;
      }
      if (mainWindow.webContents.isAudioMuted()) {
        console.log('[SF-VOICE]', new Date().toISOString().slice(11, 23), 'main:webContents-remuted-fixed');
        mainWindow.webContents.setAudioMuted(false);
        mainWindow.webContents.send('sf:restore-voice-audio', { reason: 'watch-remuted' });
      }
    } catch {
      /* ignore */
    }
    if (!shareActive && ticks >= 120) {
      clearInterval(voiceUnmuteTimer);
      voiceUnmuteTimer = null;
    }
  }, 500);
}
function stopVoiceUnmuteWatch() {
  shareActive = false;
  if (voiceUnmuteTimer) {
    clearInterval(voiceUnmuteTimer);
    voiceUnmuteTimer = null;
  }
}

ipcMain.handle('sf:get-audio-muted', () => {
  try {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) {
      return { ok: false, muted: null };
    }
    return { ok: true, muted: mainWindow.webContents.isAudioMuted() };
  } catch {
    return { ok: false, muted: null };
  }
});

ipcMain.handle('sf:set-audio-muted', (_e, muted) => {
  try {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) {
      return { ok: false };
    }
    mainWindow.webContents.setAudioMuted(!!muted);
    return { ok: true, muted: mainWindow.webContents.isAudioMuted() };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.on('sf:voice-log', (_e, payload) => {
  const event = payload?.event || 'log';
  const data = payload?.data;
  if (data && typeof data === 'object' && Object.keys(data).length) {
    console.log('[SF-VOICE]', new Date().toISOString().slice(11, 23), `renderer:${event}`, data);
  } else {
    console.log('[SF-VOICE]', new Date().toISOString().slice(11, 23), `renderer:${event}`);
  }
});

function setupMediaCapture(ses) {
  const allowPerm = new Set(['media', 'display-capture', 'fullscreen', 'notifications']);

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowPerm.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => allowPerm.has(permission));

  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const t0 = Date.now();
    console.log('[SF-VOICE]', new Date().toISOString().slice(11, 23), 'main:displayMedia:start', {
      audioRequested: !!request?.audioRequested,
      videoRequested: request?.videoRequested !== false,
    });
    try {
      const source = await chooseCaptureSource();
      lastChosenCaptureSource = source;
      lastRtmpCapture = {
        id: source.id,
        name: source.name,
        display_id: source.display_id,
      };
      const out = { video: source };
      // Discord-style: NUNCA pedir loopback Chromium aqui.
      // Áudio da app/sistema vem só via WASAPI (game-audio-capture).
      // Meter áudio no getDisplayMedia mutava a call de voz no Windows.
      console.log('[SF-VOICE]', new Date().toISOString().slice(11, 23), 'main:displayMedia:callback', {
        sourceId: source?.id,
        sourceName: source?.name,
        hasAudio: false,
        ms: Date.now() - t0,
      });
      callback(out);
      notifyRestoreVoiceAudio('displayMedia-done');
      shareActive = true;
      startVoiceUnmuteWatch();
    } catch (err) {
      console.warn('[SF-VOICE] main:displayMedia:fail', err?.message || err, { ms: Date.now() - t0 });
      console.warn('display media cancelled/failed:', err?.message || err);
      callback({});
      notifyRestoreVoiceAudio('displayMedia-cancel');
      startVoiceUnmuteWatch();
    }
  });
}

function setupDisplayMedia() {
  setupMediaCapture(communitySession());
}

ipcMain.handle('sf:get-config', () => ({
  serverUrl: SERVER_URL,
  desktop: true,
  version: app.getVersion(),
  isDev,
}));

ipcMain.handle('sf:get-settings', () => loadSettings());
ipcMain.handle('sf:set-settings', (_e, partial) => saveSettings(partial || {}));
ipcMain.handle('sf:get-saved-creds', () => readCreds());
ipcMain.handle('sf:save-creds', (_e, { username, password }) => saveCreds(username, password));
ipcMain.handle('sf:clear-creds', () => clearCreds());

ipcMain.handle('sf:auth-status', async () => {
  const { status, data } = await apiFetch('/api/auth/status');
  return { status, ...(data || {}) };
});

ipcMain.handle('sf:login', async (_e, { username, password, remember }) => {
  const { status, data } = await apiFetch('/api/auth/login', {
    method: 'POST',
    body: { username, password, desktop: true },
  });
  if ((status === 200 || status === 201) && (data?.ok || data?.user)) {
    if (remember) saveCreds(username, password);
    else clearCreds();
    loadAppUrl('/comunidade');
  } else {
    console.warn('[login] falhou', SERVER_URL, status, data?.error || data?.message || '');
  }
  return { status, ...(data || {}), serverUrl: SERVER_URL, isDev };
});

ipcMain.handle('sf:register-send-code', async () => ({ ok: false, error: 'use_web_register' }));
ipcMain.handle('sf:register', async (_e, payload) => {
  const { status, data } = await apiFetch('/api/auth/register', {
    method: 'POST',
    body: { ...payload, desktop: true },
  });
  if (status === 200 || status === 201) {
    loadAppUrl('/comunidade');
  }
  return { status, ...(data || {}) };
});

ipcMain.handle('sf:logout', async () => {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  clearCreds();
  try {
    await communitySession().clearStorageData({ storages: ['cookies'] });
  } catch {
    /* ignore */
  }
  loadAppUrl('/login');
  return { ok: true };
});

ipcMain.handle('sf:open-register', () => {
  loadAppUrl('/register');
  return { ok: true };
});
ipcMain.handle('sf:open-login', () => {
  loadAppUrl('/login');
  return { ok: true };
});

ipcMain.handle('sf:focus-window', () => {
  focusMainWindow();
  return { ok: true };
});

ipcMain.handle('sf:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:/i.test(url)) shell.openExternal(url);
});

ipcMain.handle('sf:get-picker-sources', () => {
  return pickerPending?.sources || [];
});

ipcMain.handle('sf:pick-source', (_e, id) => {
  if (!pickerPending) return { ok: false };
  const resolve = pickerPending.resolve;
  pickerPending = null;
  if (pickerWin && !pickerWin.isDestroyed()) pickerWin.close();
  pickerWin = null;
  resolve(String(id || ''));
  return { ok: true };
});

ipcMain.handle('sf:cancel-pick-source', () => {
  if (pickerPending) {
    const reject = pickerPending.reject;
    pickerPending = null;
    reject(new Error('cancelled'));
  }
  if (pickerWin && !pickerWin.isDestroyed()) pickerWin.close();
  pickerWin = null;
  return { ok: true };
});

ipcMain.handle('sf:start-local-stream', async (_e, opts) => {
  try {
    const input = opts && typeof opts === 'object' ? { ...opts } : {};
    if (!input.capture && lastRtmpCapture) {
      input.capture = lastRtmpCapture;
    }
    if (!input.quality && shareCapturePrefs?.quality) {
      input.quality = shareCapturePrefs.quality;
    }
    if (!input.fps && shareCapturePrefs?.fps) {
      input.fps = shareCapturePrefs.fps;
    }
    if (!input.audioMode) {
      input.audioMode = shareAudioMode || 'off';
    }
    if (input.audioMode === 'game') {
      input.audioMode = 'system';
    }
    return await startLocalStream(input);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
ipcMain.handle('sf:stop-local-stream', () => stopLocalStream());
ipcMain.handle('sf:set-share-audio-mode', (_e, mode) => {
  const m = String(mode || 'off').toLowerCase();
  shareAudioMode =
    m === 'system' || m === 'game' || m === 'app' ? (m === 'game' ? 'app' : m) : 'off';
  return { ok: true, mode: shareAudioMode };
});

/** Chromium loopbackWithMute / drivers podem deixar o endpoint mudo — força unmute. */
function unmuteDefaultSpeakers() {
  if (process.platform !== 'win32') return Promise.resolve({ ok: true, skipped: true });
  // typeof(IAudioEndpointVolume).GUID falha em Add-Type — GUID explícito.
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class SfAudio2 {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumerator {}
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int NotImpl1();
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
  }
  [Guid("5CDF2C82-841E-4546-9722-0CF740782BA3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int NotImpl1(); int NotImpl2();
    int GetChannelCount(out uint pcChannels);
    int SetMasterVolumeLevel(float fLevelDB, Guid pguidEventContext);
    int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
    int GetMasterVolumeLevel(out float pfLevelDB);
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int SetChannelVolumeLevel(uint nChannel, float fLevelDB, Guid pguidEventContext);
    int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, Guid pguidEventContext);
    int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
    [PreserveSig] int GetMute(out bool pbMute);
  }
  static string UnmuteRole(int role) {
    var enumerator = (IMMDeviceEnumerator)(object)new MMDeviceEnumerator();
    IMMDevice device;
    int hr = enumerator.GetDefaultAudioEndpoint(0, role, out device);
    if (hr != 0 || device == null) return "endpoint_hr=" + hr;
    Guid iid = new Guid("5CDF2C82-841E-4546-9722-0CF740782BA3");
    object o;
    hr = device.Activate(ref iid, 1, IntPtr.Zero, out o);
    if (hr != 0 || o == null) return "activate_hr=" + hr;
    var vol = (IAudioEndpointVolume)o;
    bool muted;
    vol.GetMute(out muted);
    vol.SetMute(false, Guid.Empty);
    float level;
    vol.GetMasterVolumeLevelScalar(out level);
    if (level < 0.05f) vol.SetMasterVolumeLevelScalar(0.7f, Guid.Empty);
    vol.GetMute(out muted);
    vol.GetMasterVolumeLevelScalar(out level);
    return "ok;role=" + role + ";muted=" + muted + ";level=" + level.ToString("0.00");
  }
  public static string Unmute() {
    string a = UnmuteRole(1);
    string b = UnmuteRole(0);
    string c = UnmuteRole(2);
    return a + "|" + b + "|" + c;
  }
}
"@
try { [SfAudio2]::Unmute() } catch { "err:" + $_.Exception.Message }
`;
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, error: err.message });
          return;
        }
        const out = String(stdout || '').trim();
        resolve({ ok: /ok;role=/.test(out), raw: out });
      },
    );
  });
}

ipcMain.handle('sf:ensure-speakers-unmuted', async () => unmuteDefaultSpeakers());
ipcMain.handle('sf:set-share-active', (_e, active) => {
  shareActive = !!active;
  if (shareActive) startVoiceUnmuteWatch();
  else stopVoiceUnmuteWatch();
  return { ok: true, shareActive };
});
ipcMain.handle('sf:set-share-capture-prefs', (_e, prefs) => {
  const p = prefs && typeof prefs === 'object' ? prefs : {};
  const m = String(p.audioMode || 'off').toLowerCase();
  shareAudioMode =
    m === 'system' || m === 'game' || m === 'app' ? (m === 'game' ? 'app' : m) : 'off';
  const q = String(p.quality || '720');
  const fps = Number(p.fps);
  shareCapturePrefs = {
    quality: q === '480' || q === '1080' || q === 'source' ? q : '720',
    fps: Number.isFinite(fps) ? Math.max(15, Math.min(60, fps)) : 30,
  };
  return { ok: true, audioMode: shareAudioMode, capture: shareCapturePrefs };
});
ipcMain.handle('sf:start-game-audio', async (event) => {
  if (shareAudioMode !== 'app' && shareAudioMode !== 'game') {
    return { ok: false, reason: 'wrong_mode' };
  }
  return startGameAudioCapture(event.sender, lastChosenCaptureSource);
});
ipcMain.handle('sf:start-system-audio', async (event) => {
  if (shareAudioMode !== 'system') {
    return { ok: false, reason: 'wrong_mode' };
  }
  return startSystemAudioCapture(event.sender);
});
ipcMain.handle('sf:stop-game-audio', () => stopGameAudioCapture());

ipcMain.handle('sf:get-update-status', () => ({
  ready: updateReady,
  downloading: updateDownloading,
  version: pendingUpdateInfo?.version || '',
  available: updateReady || updateDownloading,
}));
ipcMain.handle('sf:prompt-install-update', () => promptInstallUpdate(pendingUpdateInfo));

ipcMain.handle('sf:remote-status', async () => {
  try {
    const cfg = await apiFetch('/api/remote/config').catch(() => ({ data: {} }));
    const d = cfg.data || {};
    const status = await remoteRustdesk.configureAndGetId({
      idServer: d.id_server || '',
      key: d.key || '',
      relayServer: d.relay_server || d.id_server || '',
    });
    return { ok: true, ...status, config: { id_server: d.id_server || '', key: d.key || '' } };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:remote-prepare-host', async (_e, opts) => {
  try {
    const cfg = await apiFetch('/api/remote/config').catch(() => ({ data: {} }));
    const d = cfg.data || {};
    const password = String(opts?.password || '').trim();
    if (!password) return { ok: false, error: 'missing_password' };
    const prepared = await remoteRustdesk.prepareHost({
      idServer: d.id_server || '',
      key: d.key || '',
      relayServer: d.relay_server || d.id_server || '',
      password,
    });
    return { ok: true, rustdesk_id: prepared.rustdeskId };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:remote-connect', async (_e, opts) => {
  try {
    const hostId = String(opts?.host_id || opts?.rustdesk_id || '').trim();
    const password = String(opts?.password || '').trim();
    if (!hostId) return { ok: false, error: 'missing_host_id' };
    const cfg = await apiFetch('/api/remote/config').catch(() => ({ data: {} }));
    const d = cfg.data || {};
    await remoteRustdesk.connectToHost(hostId, password, {
      idServer: d.id_server || '',
      key: d.key || '',
      relayServer: d.relay_server || d.id_server || '',
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:remote-end', async () => {
  try {
    await remoteRustdesk.endRemoteSession();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:match-prepare-host', async (e, opts) => {
  try {
    const s = loadSettings();
    const userDataPath = app.getPath('userData');
    const packVer = String(opts?.matchPackVersion || '').trim();
    if (packVer) {
      const ensured = await matchPacks.ensurePack({
        version: packVer,
        userDataPath,
        serverUrl: SERVER_URL,
        fetchJson: (pathname) => apiFetch(pathname),
        fetchBinary: (pathname) => apiFetchBinary(pathname),
      });
      if (!ensured.ok) {
        return {
          ok: false,
          error: ensured.error || 'match_pack_failed',
          phase: 'failed',
          message: `Falha ao obter pack ${packVer}: ${ensured.error || 'erro'}`,
        };
      }
    }
    return await matchConnect.prepareHostListen({
      ...(opts || {}),
      gslt: (opts && opts.gslt) || s.cs2Gslt || process.env.SF_CS2_GSLT || '',
      gsltPath: path.join(userDataPath, 'cs2-gslt.txt'),
      userDataPath,
      onProgress: (p) => {
        try {
          if (e?.sender && !e.sender.isDestroyed()) {
            e.sender.send('sf:match-boot-progress', p || {});
          }
        } catch {
          /* ignore */
        }
      },
    });
  } catch (e2) {
    return { ok: false, error: e2?.message || String(e2), phase: 'failed' };
  }
});

ipcMain.handle('sf:match-ensure-pack', async (_e, opts) => {
  try {
    const version = String(opts?.version || '').trim();
    return await matchPacks.ensurePack({
      version,
      userDataPath: app.getPath('userData'),
      serverUrl: SERVER_URL,
      fetchJson: (pathname) => apiFetch(pathname),
      fetchBinary: (pathname) => apiFetchBinary(pathname),
    });
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:match-list-installed-packs', async () => {
  try {
    return { ok: true, ...matchPacks.listInstalled(app.getPath('userData')) };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:match-gslt-get', async () => {
  try {
    const s = loadSettings();
    const token = String(s.cs2Gslt || process.env.SF_CS2_GSLT || '').trim();
    return {
      ok: true,
      hasToken: !!token,
      tokenPreview: token ? `${token.slice(0, 4)}…${token.slice(-4)}` : '',
      url: 'https://steamcommunity.com/dev/managegameservers',
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:match-gslt-set', async (_e, token) => {
  try {
    const t = String(token || '').trim();
    saveSettings({ cs2Gslt: t });
    try {
      fs.writeFileSync(path.join(app.getPath('userData'), 'cs2-gslt.txt'), t, 'utf8');
    } catch {
      /* ignore */
    }
    return { ok: true, hasToken: !!t };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:match-open-tunnel', async (_e, opts) => {
  try {
    const matchId = String(opts?.matchId || '').trim();
    const localPort = Number(opts?.localPort) || 0;
    if (!matchId || !localPort) return { ok: false, error: 'missing_tunnel_opts' };
    const { status, data } = await apiFetch(`/api/private-match/${matchId}/tunnel`, {
      method: 'POST',
      body: {},
    });
    if (status >= 400 || !data?.ok || !data.token) {
      return { ok: false, error: data?.error || `tunnel_http_${status}` };
    }
    const tun = await matchTunnel.start({
      token: data.token,
      relayHost: data.relayHost,
      relayPort: data.relayPort,
      localPort,
      publicHost: data.publicHost,
      publicPort: data.publicPort,
    });
    if (!tun?.ok) return tun;
    return {
      ok: true,
      via: 'vps-relay',
      publicHost: tun.publicHost || data.publicHost,
      publicPort: tun.publicPort || data.publicPort,
      relayHost: data.relayHost,
      relayPort: data.relayPort,
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:match-connect', async (_e, opts) => {
  try {
    const s = loadSettings();
    const vk = Number((opts && opts.consoleVk) || s.cs2ConsoleVk) || 0xde;
    return await matchConnect.connectToServer({
      ...(opts || {}),
      consoleVk: vk,
    });
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:match-console-key-get', async () => {
  try {
    const s = loadSettings();
    const hasVk = s.cs2ConsoleVk !== undefined && s.cs2ConsoleVk !== null && s.cs2ConsoleVk !== '';
    const configured = s.cs2ConsoleKeyConfigured === true || hasVk;
    return {
      ok: true,
      configured,
      consoleVk: Number(s.cs2ConsoleVk) || 0,
      options: [
        { vk: 0xde, label: "Aspas \" / ' (OEM_7) — teclado BR" },
        { vk: 0xc0, label: '~ / grave (OEM_3)' },
        { vk: 0xdc, label: '\\ (OEM_5)' },
        { vk: 0x78, label: 'F9' },
        { vk: 0x2d, label: 'Insert' },
        { vk: 0, label: 'Auto (tenta várias)' },
      ],
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:match-console-key-set', async (_e, vk) => {
  try {
    const n = Number(vk);
    saveSettings({
      cs2ConsoleVk: Number.isFinite(n) ? n : 0,
      cs2ConsoleKeyConfigured: true,
    });
    return { ok: true, consoleVk: Number.isFinite(n) ? n : 0, configured: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:match-dedicated-snapshot', async () => {
  try {
    return await matchConnect.dedicatedSnapshot();
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:match-dedicated-exec', async (_e, cmd) => {
  try {
    return await matchConnect.dedicatedExec(cmd);
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:match-rewrite-teams', async (_e, players) => {
  try {
    return matchConnect.rewriteTeams(players || []);
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:match-admin-settings', async (_e, settings) => {
  try {
    return await matchConnect.applyAdminSettings(settings || {});
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:match-sound-settings', async (_e, settings) => {
  try {
    const next = settings || {};
    const r = matchConnect.applySoundSettings(next);
    if (r?.ok) {
      try {
        const prefsPath = path.join(app.getPath('userData'), 'kill-sounds-prefs.json');
        fs.writeFileSync(prefsPath, JSON.stringify(r.settings || next, null, 2), 'utf8');
      } catch {
        /* ignore */
      }
    }
    return r;
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:match-sound-prefs-get', async () => {
  try {
    const prefsPath = path.join(app.getPath('userData'), 'kill-sounds-prefs.json');
    if (!fs.existsSync(prefsPath)) {
      return { ok: true, settings: matchServerMods.defaultKillSoundsSettings() };
    }
    const settings = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    return { ok: true, settings };
  } catch (e) {
    return {
      ok: true,
      settings: matchServerMods.defaultKillSoundsSettings(),
      error: e?.message || String(e),
    };
  }
});

ipcMain.handle('sf:match-admin-bots', async (_e, action) => {
  try {
    return await matchConnect.applyAdminBots(action || '');
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:match-history-list', async (_e, opts) => {
  try {
    return matchHistory.list(opts && opts.limit);
  } catch (e) {
    return { ok: false, error: e?.message || String(e), matches: [] };
  }
});

ipcMain.handle('sf:match-history-push', async (_e, entry) => {
  try {
    return matchHistory.push(entry || {});
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:match-history-clear', async () => {
  try {
    return matchHistory.clear();
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:match-open-cs2', async () => {
  try {
    return await matchConnect.openCs2Only();
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:match-dedicated-status', async () => {
  try {
    return matchConnect.dedicatedStatus();
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:match-dedicated-stop', async () => {
  try {
    matchTunnel.stop();
    return await matchConnect.stopDedicated();
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

function broadcastGsiUpdate(snap) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send('sf:gsi-update', snap);
    } catch {
      /* ignore */
    }
  }
}

cs2Gsi.setUpdateHandler(broadcastGsiUpdate);

function broadcastGsiMatchSaved(match) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send('sf:gsi-match-saved', match);
    } catch {
      /* ignore */
    }
  }
}

cs2Gsi.setMatchSavedHandler(broadcastGsiMatchSaved);

ipcMain.handle('sf:gsi-status', () => {
  const s = loadSettings();
  const enabledSetting = s.cs2GsiEnabled !== false;
  return {
    ...cs2Gsi.status(),
    cfgDir: s.cs2CfgDir || '',
    cfgPath: s.cs2CfgPath || '',
    enabledSetting,
    autoDefault: true,
    needsFolder: enabledSetting && !String(s.cs2CfgDir || '').trim(),
  };
});

ipcMain.handle('sf:gsi-enable', async () => {
  try {
    return await cs2Gsi.enable({
      loadSettings,
      saveSettings,
      parentWindow: mainWindow && !mainWindow.isDestroyed() ? mainWindow : null,
    });
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:gsi-redeploy', async () => {
  try {
    return await cs2Gsi.redeploy({
      loadSettings,
      saveSettings,
      parentWindow: mainWindow && !mainWindow.isDestroyed() ? mainWindow : null,
      pickFolder: true,
    });
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:gsi-disable', () => {
  try {
    return cs2Gsi.disable({ loadSettings, saveSettings });
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:gsi-detect', () => {
  const s = loadSettings();
  const cfgDir = cs2Gsi.detectCfgDir(s.cs2CfgDir || '');
  return { ok: !!cfgDir, cfgDir: cfgDir || '', cfgName: cs2Gsi.CFG_NAME };
});

ipcMain.handle('sf:gsi-history', (_e, opts) => {
  try {
    const limit = opts && typeof opts === 'object' ? opts.limit : opts;
    return { ok: true, matches: cs2Gsi.listHistory(limit) };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), matches: [] };
  }
});

ipcMain.handle('sf:gsi-history-get', (_e, id) => {
  try {
    const match = cs2Gsi.getHistoryMatch(String(id || ''));
    return { ok: !!match, match };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), match: null };
  }
});

ipcMain.handle('sf:gsi-history-clear', () => {
  try {
    return { ok: true, ...cs2Gsi.clearHistory() };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('sf:gsi-history-merge-valve', (_e, payload) => {
  try {
    const matchId = payload?.matchId || payload?.id || '';
    const valve = payload?.valve || payload?.match || payload;
    return cs2Gsi.mergeHistoryValve(matchId, valve);
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    focusMainWindow();
  });

  app.whenReady().then(async () => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('app.openguild.desktop');
    }
    cs2Gsi.configure({ userDataPath: app.getPath('userData') });
    matchHistory.configure({ userDataPath: app.getPath('userData') });
    setupAppMenu();
    saveSettings(loadSettings());
    applyBrandToUi(currentBrandName());
    ensureTray();
    setupDisplayMedia();
    setupAutoUpdate();
    await refreshWebCache();
    await waitForDevServer();
    await syncBrandFromServer();
    setInterval(() => {
      void syncBrandFromServer();
    }, 15 * 60 * 1000);
    await bootstrapSession();
    // Janela só existe após bootstrap — reaplica título/ícone
    applyBrandToUi(currentBrandName());
    const s = loadSettings();
    updateWindowsShortcuts(currentBrandName(), s.brandIconIco || '');
    try {
      // GSI automático (cfg + listener). Desactivar só nas definições.
      await cs2Gsi.restoreIfEnabled({ loadSettings, saveSettings });
    } catch {
      /* ignore */
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void bootstrapSession();
      } else {
        focusMainWindow();
      }
    });
  });
}

app.on('before-quit', () => {
  quitting = true;
  notifyRendererLeaving();
  try {
    stopLocalStream();
  } catch {
    /* ignore */
  }
  try {
    stopGameAudioCapture();
  } catch {
    /* ignore */
  }
  try {
    cs2Gsi.stopServer();
  } catch {
    /* ignore */
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && quitting) app.quit();
});
