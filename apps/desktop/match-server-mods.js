/**
 * Metamod + CounterStrikeSharp + SfAssignTeams no overlay local
 * ({userData}/cs2-overlay/game). Nunca escreve no gameinfo.gi da Steam.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const os = require('os');

const CSS_VERSION = '1.0.374';
const CSS_ZIP = `counterstrikesharp-with-runtime-windows-${CSS_VERSION}.zip`;
const CSS_URL = `https://github.com/roflmuffin/CounterStrikeSharp/releases/download/v${CSS_VERSION}/${CSS_ZIP}`;

/** MultiAddonManager v1.5.4 — compatível com Metamod ~1410 (v1.6+ exige Metamod >1459). */
const MAM_VERSION = '1.5.4';
const MAM_ZIP = `MultiAddonManager-v${MAM_VERSION}-windows.zip`;
const MAM_URL = `https://github.com/Source2ZE/MultiAddonManager/releases/download/v${MAM_VERSION}/${MAM_ZIP}`;
const QUAKE_WORKSHOP_ID = '3461824328';

const MM_URLS = [
  'https://mms.alliedmods.net/mmsdrop/2.0/mmsource-2.0.0-git1410-windows.zip',
  'https://mms.alliedmods.net/mmsdrop/2.0/mmsource-2.0.0-git1407-windows.zip',
  'https://mms.alliedmods.net/mmsdrop/2.0/mmsource-2.0.0-git1396-windows.zip',
  'https://mms.alliedmods.net/mmsdrop/2.0/mmsource-latest-windows',
];

const GI_COMMENT = '// SteamFarm dedicated metamod (overlay only)';
const MIN_GAMEINFO_BYTES = 500;

function defaultKillSoundsSettings() {
  return {
    enabled: false,
    workshopIds: [QUAKE_WORKSHOP_ID],
    intensity: 'med',
    soundEventFile: 'soundevents/soundevents_quakesounds.vsndevts',
    events: {
      kill: 'QuakeSoundsD.Humiliation',
      headshot: 'QuakeSoundsD.Headshot',
      firstBlood: 'QuakeSoundsD.Firstblood',
      knife: 'QuakeSoundsD.Haha',
      doubleKill: 'QuakeSoundsD.Doublekill',
      tripleKill: 'QuakeSoundsD.Triplekill',
      killstreak: 'QuakeSoundsD.Killingspree',
    },
  };
}

function pluginDllPath(userDataPath, fileName = 'SfAssignTeams.dll') {
  const overrides = [];
  if (userDataPath) {
    overrides.push(path.join(userDataPath, 'cs2-plugin-override', fileName));
  }
  overrides.push(
    path.join(
      os.homedir(),
      'AppData',
      'Roaming',
      '@steamfarm',
      'desktop',
      'cs2-plugin-override',
      fileName,
    ),
  );
  // Pack/hotfix no override ganha sempre ao asar instalado (senão fica o SfKillSounds 1.4.2).
  for (const p of overrides) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  const bundled = [];
  if (process.resourcesPath) {
    bundled.push(path.join(process.resourcesPath, 'cs2-plugin', fileName));
  }
  bundled.push(path.join(__dirname, 'resources', 'cs2-plugin', fileName));
  let best = '';
  let bestMtime = -1;
  for (const p of bundled) {
    try {
      if (!fs.existsSync(p)) continue;
      const st = fs.statSync(p);
      if (st.mtimeMs >= bestMtime) {
        bestMtime = st.mtimeMs;
        best = p;
      }
    } catch {
      /* ignore */
    }
  }
  return best || bundled[bundled.length - 1];
}

function installOnePluginDll(csgoDir, userDataPath, pluginFolder, fileName) {
  const src = pluginDllPath(userDataPath, fileName);
  if (!fs.existsSync(src)) return { ok: false, error: `${pluginFolder}_dll_missing`, src };
  const destDir = path.join(csgoDir, 'addons', 'counterstrikesharp', 'plugins', pluginFolder);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, fileName);
  try {
    if (fs.existsSync(dest)) {
      const a = fs.statSync(src);
      const b = fs.statSync(dest);
      // Só skip se dest for exactamente o mesmo ficheiro (tamanho+mtime)
      if (a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 2000) {
        return { ok: true, skipped: 'same', dest, src };
      }
    }
  } catch {
    /* ignore */
  }
  fs.copyFileSync(src, dest);
  try {
    // Alinha mtime para a próxima comparação
    const now = new Date();
    fs.utimesSync(dest, now, now);
  } catch {
    /* ignore */
  }
  return { ok: true, dest, src, bytes: fs.statSync(dest).size };
}

function installPluginDll(csgoDir, userDataPath) {
  const assign = installOnePluginDll(csgoDir, userDataPath, 'SfAssignTeams', 'SfAssignTeams.dll');
  if (!assign.ok) return assign;
  const sounds = installOnePluginDll(csgoDir, userDataPath, 'SfKillSounds', 'SfKillSounds.dll');
  // Sons são opcionais até o pack 1.4.0 existir localmente
  return {
    ok: true,
    dest: assign.dest,
    src: assign.src,
    bytes: assign.bytes,
    killSounds: sounds.ok ? sounds : { ok: false, error: sounds.error },
  };
}

function httpsDownload(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const go = (u, n = 0) => {
      https
        .get(
          u,
          {
            timeout: 120000,
            headers: {
              'User-Agent': 'Mozilla/5.0 SteamFarm-Comunidade',
              Accept: '*/*',
            },
          },
          (res) => {
            const code = res.statusCode || 0;
            if (code >= 300 && code < 400 && res.headers.location) {
              res.resume();
              if (n > 8) return reject(new Error('too_many_redirects'));
              go(res.headers.location, n + 1);
              return;
            }
            if (code !== 200) {
              res.resume();
              reject(new Error(`HTTP ${code} ${u}`));
              return;
            }
            res.pipe(file);
            file.on('finish', () => file.close(() => resolve(dest)));
          },
        )
        .on('error', reject);
    };
    go(url);
  });
}

function unzip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Force -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}'`,
      ],
      { windowsHide: true, timeout: 180000 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message)));
        else resolve();
      },
    );
  });
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, ent.name);
    const b = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

function modsReady(csgoDir) {
  const mm =
    fs.existsSync(path.join(csgoDir, 'addons', 'metamod.vdf')) ||
    fs.existsSync(path.join(csgoDir, 'addons', 'metamod', 'metaplugins.ini'));
  const css = fs.existsSync(
    path.join(csgoDir, 'addons', 'counterstrikesharp', 'bin', 'win64', 'counterstrikesharp.dll'),
  );
  const plug = fs.existsSync(
    path.join(csgoDir, 'addons', 'counterstrikesharp', 'plugins', 'SfAssignTeams', 'SfAssignTeams.dll'),
  );
  const mam =
    fs.existsSync(path.join(csgoDir, 'addons', 'metamod', 'multiaddonmanager.vdf')) ||
    fs.existsSync(path.join(csgoDir, 'addons', 'multiaddonmanager'));
  const killSounds = fs.existsSync(
    path.join(csgoDir, 'addons', 'counterstrikesharp', 'plugins', 'SfKillSounds', 'SfKillSounds.dll'),
  );
  return { mm, css, plug, mam, killSounds, ok: mm && css && plug };
}

async function downloadFirst(urls, dest) {
  let last = '';
  for (const url of urls) {
    try {
      await httpsDownload(url, dest);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 80_000) return dest;
    } catch (e) {
      last = e?.message || String(e);
    }
  }
  throw new Error(last || 'metamod_download_failed');
}

async function ensureServerMods(gameRoot, cacheDir, userDataPath) {
  const csgoDir = path.join(gameRoot, 'csgo');
  const cache = cacheDir || path.join(os.tmpdir(), 'steamfarm-cs2-mods');
  fs.mkdirSync(cache, { recursive: true });
  const ud =
    userDataPath ||
    (cacheDir && path.basename(String(cacheDir)) === 'cs2-mods'
      ? path.dirname(String(cacheDir))
      : '');

  const fatalLog = path.join(csgoDir, 'addons', 'metamod', 'bin', 'win64', 'metamod-fatal.log');
  let forceMm = false;
  let forceCss = false;
  try {
    if (fs.existsSync(fatalLog)) {
      const fatal = fs.readFileSync(fatalLog, 'utf8');
      if (/could not load|procedimento especificado|engine \d+/i.test(fatal)) {
        forceMm = true;
      }
    }
  } catch {
    /* ignore */
  }
  // Log do dedicated: CSS antigo falha com "procedimento especificado" mesmo com Metamod OK
  try {
    const userDataGuess = path.resolve(csgoDir, '..', '..', '..', '..');
    const dlog = path.join(userDataGuess, 'sf-cs2-dedicated.log');
    if (fs.existsSync(dlog)) {
      const tail = fs.readFileSync(dlog, 'utf8').slice(-12000);
      if (/Failed to load plugin addons\/counterstrikesharp.*procedimento especificado/i.test(tail)) {
        forceCss = true;
      }
    }
  } catch {
    /* ignore */
  }

  const ready = modsReady(csgoDir);
  if (!ready.ok || forceMm || forceCss) {
    if (!ready.mm || forceMm) {
      const mmZip = path.join(cache, 'metamod-windows-1410.zip');
      const needDl = !fs.existsSync(mmZip) || fs.statSync(mmZip).size < 80_000 || forceMm;
      if (needDl) {
        // apaga cache antigo incompatível
        try {
          fs.unlinkSync(path.join(cache, 'metamod-windows.zip'));
        } catch {
          /* ignore */
        }
        await downloadFirst(MM_URLS, mmZip);
      }
      const mmExtract = path.join(cache, 'metamod-extract');
      try {
        fs.rmSync(mmExtract, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      await unzip(mmZip, mmExtract);
      const addonsSrc = findAddonsRoot(mmExtract);
      if (!addonsSrc) throw new Error('metamod_zip_layout');
      // limpar metamod antigo no overlay antes de copiar
      try {
        fs.rmSync(path.join(csgoDir, 'addons', 'metamod'), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      copyDir(addonsSrc, path.join(csgoDir, 'addons'));
      try {
        fs.unlinkSync(fatalLog);
      } catch {
        /* ignore */
      }
    }
    if (!ready.css || forceCss) {
      const cssZip = path.join(cache, CSS_ZIP);
      if (!fs.existsSync(cssZip) || fs.statSync(cssZip).size < 1_000_000 || forceCss) {
        try {
          fs.unlinkSync(path.join(cache, `counterstrikesharp-with-runtime-windows-1.0.340.zip`));
        } catch {
          /* ignore */
        }
        await httpsDownload(CSS_URL, cssZip);
      }
      const cssExtract = path.join(cache, 'css-extract');
      try {
        fs.rmSync(cssExtract, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      await unzip(cssZip, cssExtract);
      const addonsSrc = findAddonsRoot(cssExtract);
      if (!addonsSrc) throw new Error('css_zip_layout');
      try {
        fs.rmSync(path.join(csgoDir, 'addons', 'counterstrikesharp'), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      copyDir(addonsSrc, path.join(csgoDir, 'addons'));
    }
  }
  // forceMm apaga addons/metamod e remove o .vdf do CSS → Metamod fica com 0 plugins.
  ensureCssMetamodVdf(csgoDir);
  patchCssCoreConfig(csgoDir);
  await ensureMultiAddonManager(csgoDir, cache);
  const plug = installPluginDll(csgoDir, ud);
  if (!plug.ok) return { ok: false, error: plug.error, ...modsReady(csgoDir) };
  // Reescreve cfg MAM depois da instalação (workshop Quake)
  try {
    writeMultiAddonManagerCfg(csgoDir, [QUAKE_WORKSHOP_ID]);
  } catch {
    /* ignore */
  }
  return {
    ok: true,
    forceMm,
    pluginSrc: plug.src,
    killSounds: plug.killSounds,
    ...modsReady(csgoDir),
  };
}

/** Instala MultiAddonManager (Metamod) para forçar download do Workshop de sons. */
async function ensureMultiAddonManager(csgoDir, cacheDir) {
  const ready =
    fs.existsSync(path.join(csgoDir, 'addons', 'metamod', 'multiaddonmanager.vdf')) ||
    fs.existsSync(path.join(csgoDir, 'addons', 'multiaddonmanager', 'bin'));
  const cache = cacheDir || path.join(os.tmpdir(), 'steamfarm-cs2-mods');
  fs.mkdirSync(cache, { recursive: true });
  if (!ready) {
    const zip = path.join(cache, MAM_ZIP);
    if (!fs.existsSync(zip) || fs.statSync(zip).size < 50_000) {
      await httpsDownload(MAM_URL, zip);
    }
    const extract = path.join(cache, 'mam-extract');
    try {
      fs.rmSync(extract, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    await unzip(zip, extract);
    // Zip tipicamente contém game/csgo/... ou csgo/... ou addons/
    const csgoSrc = findCsgoRoot(extract) || findAddonsRoot(extract);
    if (!csgoSrc) throw new Error('mam_zip_layout');
    if (path.basename(csgoSrc) === 'addons') {
      copyDir(csgoSrc, path.join(csgoDir, 'addons'));
    } else {
      // csgo root
      copyDir(csgoSrc, csgoDir);
    }
  }
  ensureMamMetamodVdf(csgoDir);
  return { ok: true };
}

function findCsgoRoot(root) {
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    try {
      if (path.basename(dir).toLowerCase() === 'csgo' && fs.existsSync(path.join(dir, 'addons'))) {
        return dir;
      }
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory()) queue.push(path.join(dir, ent.name));
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function ensureMamMetamodVdf(csgoDir) {
  const dest = path.join(csgoDir, 'addons', 'metamod', 'multiaddonmanager.vdf');
  const candidates = [
    dest,
    path.join(csgoDir, 'addons', 'multiaddonmanager', 'multiaddonmanager.vdf'),
  ];
  let src = '';
  for (const c of candidates) {
    if (fs.existsSync(c) && c !== dest) {
      src = c;
      break;
    }
  }
  if (!fs.existsSync(dest)) {
    const body =
      src && fs.existsSync(src)
        ? fs.readFileSync(src, 'utf8')
        : `"Plugin"\n{\n\t"file"\t"addons/multiaddonmanager/bin/win64/multiaddonmanager"\n}\n`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body, 'utf8');
  }
}

/** Garante cfg MultiAddonManager com workshop IDs (sons Quake). */
function writeMultiAddonManagerCfg(csgoDir, workshopIds) {
  const ids = (Array.isArray(workshopIds) ? workshopIds : [])
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  const cfgDir = path.join(csgoDir, 'cfg', 'multiaddonmanager');
  fs.mkdirSync(cfgDir, { recursive: true });
  const lines = [
    '// SteamFarm private match — gerado automaticamente',
    `mm_extra_addons "${ids.join(',')}"`,
    'mm_block_disconnect_messages 1',
    'mm_cache_clients_with_addons 1',
    '',
  ];
  fs.writeFileSync(path.join(cfgDir, 'multiaddonmanager.cfg'), lines.join('\n'), 'utf8');
  return { ok: true, ids };
}

/** Partida privada: o fallback de sons usa comando no cliente (EmitSoundFilter partido). */
function patchCssCoreConfig(csgoDir) {
  const file = path.join(csgoDir, 'addons', 'counterstrikesharp', 'configs', 'core.json');
  if (!fs.existsSync(file)) return { ok: false };
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfg.FollowCS2ServerGuidelines = false;
    if (cfg.AutoUpdateEnabled == null) cfg.AutoUpdateEnabled = true;
    fs.writeFileSync(file, JSON.stringify(cfg, null, 4) + '\n', 'utf8');
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** Garante que o Metamod carrega o CounterStrikeSharp (vdf em addons/metamod/). */
function ensureCssMetamodVdf(csgoDir) {
  const dest = path.join(csgoDir, 'addons', 'metamod', 'counterstrikesharp.vdf');
  const candidates = [
    path.join(csgoDir, 'addons', 'metamod', 'counterstrikesharp.vdf'),
    path.join(csgoDir, 'addons', 'counterstrikesharp', 'counterstrikesharp.vdf'),
  ];
  let src = '';
  for (const c of candidates) {
    if (fs.existsSync(c) && c !== dest) {
      src = c;
      break;
    }
  }
  const body =
    '"Metamod Plugin"\n{\n\t"alias"\t"counterstrikesharp"\n\t"file"\t"addons/counterstrikesharp/bin/win64/counterstrikesharp"\n}\n';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (src && src !== dest) {
    try {
      fs.copyFileSync(src, dest);
      return { ok: true, via: 'copy' };
    } catch {
      /* fall through */
    }
  }
  if (!fs.existsSync(dest) || !/counterstrikesharp/i.test(fs.readFileSync(dest, 'utf8'))) {
    fs.writeFileSync(dest, body, 'utf8');
  }
  return { ok: true, via: 'write' };
}

function findAddonsRoot(root) {
  const direct = path.join(root, 'addons');
  if (fs.existsSync(direct)) return direct;
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const nested = path.join(root, ent.name, 'addons');
    if (fs.existsSync(nested)) return nested;
  }
  return '';
}

function gameinfoPath(gameRoot) {
  return path.join(gameRoot, 'csgo', 'gameinfo.gi');
}

function readGameinfoSafe(gi) {
  if (!fs.existsSync(gi)) return { ok: false, error: 'missing' };
  const buf = fs.readFileSync(gi);
  if (!buf.length || buf.length < MIN_GAMEINFO_BYTES) {
    return { ok: false, error: 'empty_or_corrupt', length: buf.length };
  }
  return { ok: true, text: buf.toString('utf8'), length: buf.length };
}

function buildPatchedGameinfo(orig) {
  if (orig.includes('csgo/addons/metamod')) return orig;
  if (/Game_LowViolence\s+csgo_lv/.test(orig)) {
    return orig.replace(
      /(Game_LowViolence\s+csgo_lv[^\n]*\n)/,
      `$1\t\t${GI_COMMENT}\n\t\tGame\tcsgo/addons/metamod\n`,
    );
  }
  return orig.replace(
    /SearchPaths\s*\r?\n\s*\{/,
    (m) => `${m}\n\t\t${GI_COMMENT}\n\t\tGame\tcsgo/addons/metamod`,
  );
}

function removePathQuiet(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isDirectory() && !st.isSymbolicLink()) {
      fs.rmSync(p, { recursive: true, force: true });
    } else {
      fs.unlinkSync(p);
    }
    return true;
  } catch {
    return false;
  }
}

function linkPointsTo(linkPath, targetPath) {
  try {
    const st = fs.lstatSync(linkPath);
    if (!st.isSymbolicLink()) return false;
    const cur = fs.readlinkSync(linkPath);
    const resolved = path.isAbsolute(cur)
      ? path.resolve(cur)
      : path.resolve(path.dirname(linkPath), cur);
    return resolved.toLowerCase() === path.resolve(targetPath).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Pastas → junction. Ficheiros → hardlink (mesmo volume) ou cópia.
 * Junctions Windows não servem para ficheiros.
 */
function ensureLink(linkPath, targetPath) {
  const target = path.resolve(targetPath);
  if (!fs.existsSync(target)) return { ok: false, error: 'target_missing' };

  let targetIsDir = false;
  try {
    targetIsDir = fs.statSync(target).isDirectory();
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }

  try {
    let exists = false;
    let st = null;
    try {
      st = fs.lstatSync(linkPath);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists && st) {
      const isReparse = st.isSymbolicLink() || (st.isDirectory() && !!(st.attributes & 0x400));
      // Ficheiro Steam nunca pode ficar como junction/dir no overlay
      if (!targetIsDir && (st.isDirectory() || st.isSymbolicLink())) {
        removePathQuiet(linkPath);
      } else if (targetIsDir && linkPointsTo(linkPath, target)) {
        return { ok: true, exists: true };
      } else if (!targetIsDir && !st.isSymbolicLink() && !st.isDirectory()) {
        try {
          const a = fs.statSync(linkPath);
          const b = fs.statSync(target);
          if (a.ino && b.ino && a.ino === b.ino && a.dev === b.dev) {
            return { ok: true, exists: true, hardlink: true };
          }
        } catch {
          /* replace */
        }
        removePathQuiet(linkPath);
      } else if (targetIsDir && isReparse && linkPointsTo(linkPath, target)) {
        return { ok: true, exists: true };
      } else {
        removePathQuiet(linkPath);
      }
    }
  } catch {
    /* create fresh */
  }

  try {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  } catch {
    /* ignore */
  }

  if (targetIsDir) {
    try {
      fs.symlinkSync(target, linkPath, 'junction');
      return { ok: true, type: 'junction' };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  // ficheiro: hardlink → symlink file → copy
  try {
    fs.linkSync(target, linkPath);
    return { ok: true, type: 'hardlink' };
  } catch {
    /* try symlink / copy */
  }
  try {
    fs.symlinkSync(target, linkPath, 'file');
    return { ok: true, type: 'symlink' };
  } catch {
    /* copy fallback */
  }
  try {
    fs.copyFileSync(target, linkPath);
    return { ok: true, type: 'copy' };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** @deprecated use ensureLink */
function ensureJunction(linkPath, targetPath) {
  return ensureLink(linkPath, targetPath);
}

function skipOverlayEntry(name) {
  return /^(backup_round|demo_)/i.test(name) || /\.(tmp|log|bak)$/i.test(name);
}

/**
 * Overlay leve: gameinfo + addons + sf_pm_* reais; resto via junction/hardlink → Steam.
 * Nunca toca no gameinfo.gi da instalação Steam.
 */
function ensureCs2Overlay(userDataPath, steamGameRoot) {
  const steamRoot = path.resolve(steamGameRoot);
  const steamCsgo = path.join(steamRoot, 'csgo');
  const steamGi = path.join(steamCsgo, 'gameinfo.gi');
  // NUNCA escrever na pasta Steam (VAC / ficheiros não assinados).
  // Só LÊ o gameinfo oficial para gerar uma cópia patchada no overlay.
  if (!fs.existsSync(steamCsgo) || !fs.existsSync(steamGi)) {
    return { ok: false, error: 'steam_csgo_missing' };
  }
  const steamRead = readGameinfoSafe(steamGi);
  if (!steamRead.ok) {
    return { ok: false, error: `steam_gameinfo_${steamRead.error}` };
  }

  const overlayGame = path.join(String(userDataPath || ''), 'cs2-overlay', 'game');
  const overlayCsgo = path.join(overlayGame, 'csgo');
  const overlayCfg = path.join(overlayCsgo, 'cfg');
  const overlayAddons = path.join(overlayCsgo, 'addons');
  const overlayGi = path.join(overlayCsgo, 'gameinfo.gi');

  fs.mkdirSync(overlayCsgo, { recursive: true });
  fs.mkdirSync(overlayCfg, { recursive: true });
  fs.mkdirSync(overlayAddons, { recursive: true });

  const warnings = [];

  // Irmãos de csgo no game/ (csgo_imported, csgo_core, core, …) — obrigatórios no gameinfo
  for (const ent of fs.readdirSync(steamRoot, { withFileTypes: true })) {
    const name = ent.name;
    if (name === 'csgo') continue; // pasta custom (gameinfo + addons + sf_pm)
    if (skipOverlayEntry(name)) continue;
    const j = ensureLink(path.join(overlayGame, name), path.join(steamRoot, name));
    if (!j.ok) {
      if (ent.isFile()) {
        warnings.push(`game/${name}:${j.error}`);
        continue;
      }
      return { ok: false, error: `game_junction_${name}_${j.error}` };
    }
  }

  for (const ent of fs.readdirSync(steamCsgo, { withFileTypes: true })) {
    const name = ent.name;
    if (name === 'addons' || name === 'gameinfo.gi' || name === 'cfg') continue;
    if (skipOverlayEntry(name)) {
      // limpar leftovers de tentativas antigas (junctions/ficheiros errados)
      removePathQuiet(path.join(overlayCsgo, name));
      continue;
    }
    const j = ensureLink(path.join(overlayCsgo, name), path.join(steamCsgo, name));
    if (!j.ok) {
      if (ent.isFile()) {
        warnings.push(`${name}:${j.error}`);
        continue;
      }
      return { ok: false, error: `junction_${name}_${j.error}` };
    }
  }

  const steamCfg = path.join(steamCsgo, 'cfg');
  if (fs.existsSync(steamCfg)) {
    for (const ent of fs.readdirSync(steamCfg, { withFileTypes: true })) {
      if (/^sf_pm_/i.test(ent.name)) continue;
      if (skipOverlayEntry(ent.name)) continue;
      const dest = path.join(overlayCfg, ent.name);
      const j = ensureLink(dest, path.join(steamCfg, ent.name));
      if (!j.ok) warnings.push(`cfg/${ent.name}:${j.error}`);
    }
  }

  const patched = buildPatchedGameinfo(steamRead.text);
  if (patched.length < MIN_GAMEINFO_BYTES) {
    return { ok: false, error: 'overlay_gameinfo_too_small' };
  }
  fs.writeFileSync(overlayGi, patched, 'utf8');

  const overlayExe = path.join(overlayGame, 'bin', 'win64', 'cs2.exe');
  return {
    ok: true,
    gameRoot: overlayGame,
    cfgDir: overlayCfg,
    csgoDir: overlayCsgo,
    exe: fs.existsSync(overlayExe) ? overlayExe : '',
    steamGameRoot: steamRoot,
    steamGameinfoBytes: steamRead.length,
    warnings,
  };
}

function writeTeamsFile(cfgDir, players) {
  if (!cfgDir) return { ok: false };
  const rows = (players || [])
    .filter((p) => p && Number(p.userId) > 0 && !p.simulated)
    .map((p) => ({
      steamid: String(p.steamid || '').replace(/\D/g, ''),
      name: p.displayName || p.username || p.name || '',
      username: p.username || '',
      displayName: p.displayName || '',
      names: [p.displayName, p.username, p.name].filter(Boolean),
      team: p.team === 'T' ? 'T' : p.team === 'SPEC' ? 'SPEC' : 'CT',
    }));
  fs.mkdirSync(cfgDir, { recursive: true });
  const payload = JSON.stringify({ players: rows }, null, 2);
  const file = path.join(cfgDir, 'sf_pm_teams.json');
  fs.writeFileSync(file, payload, 'utf8');
  // CSS Server.GameDirectory = .../game → alguns builds leem game/cfg (sem csgo)
  try {
    const gameRoot = path.dirname(path.dirname(cfgDir)); // .../game/csgo/cfg → .../game
    if (path.basename(path.dirname(cfgDir)) === 'csgo') {
      const altDir = path.join(gameRoot, 'cfg');
      fs.mkdirSync(altDir, { recursive: true });
      fs.writeFileSync(path.join(altDir, 'sf_pm_teams.json'), payload, 'utf8');
    }
  } catch {
    /* ignore */
  }
  return { ok: true, file, count: rows.length };
}

/** Cvars + welcome para o plugin SfAssignTeams (competitive sobrescreve cfg). */
function writeAdminFile(cfgDir, settings, welcomeMessage, welcomeColor) {
  if (!cfgDir) return { ok: false };
  const s = settings && typeof settings === 'object' ? settings : {};
  const color = String(welcomeColor || s.welcome_color || 'green')
    .trim()
    .toLowerCase()
    .slice(0, 24);
  const payloadObj = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'restart' || k === 'welcome_message' || k === 'welcome_color') continue;
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) payloadObj[k] = n;
  }
  payloadObj.welcome_message = String(welcomeMessage || s.welcome_message || '')
    .trim()
    .slice(0, 200);
  payloadObj.welcome_color = color || 'green';
  // Sempre teto >16k — senão kill/vitória nativos não sobem a conta
  if (payloadObj.mp_maxmoney == null || Number(payloadObj.mp_maxmoney) < 65000) {
    const start = Number(payloadObj.mp_startmoney);
    payloadObj.mp_maxmoney = Number.isFinite(start)
      ? Math.max(65000, start)
      : 65000;
  }
  fs.mkdirSync(cfgDir, { recursive: true });
  const payload = JSON.stringify(payloadObj, null, 2);
  const file = path.join(cfgDir, 'sf_pm_admin.json');
  fs.writeFileSync(file, payload, 'utf8');
  try {
    const gameRoot = path.dirname(path.dirname(cfgDir));
    if (path.basename(path.dirname(cfgDir)) === 'csgo') {
      const altDir = path.join(gameRoot, 'cfg');
      fs.mkdirSync(altDir, { recursive: true });
      fs.writeFileSync(path.join(altDir, 'sf_pm_admin.json'), payload, 'utf8');
    }
  } catch {
    /* ignore */
  }
  return { ok: true, file, settings: payloadObj };
}

/** Config de sons de kill (host-only) para SfKillSounds + MultiAddonManager. */
function writeSoundsFile(cfgDir, settings) {
  if (!cfgDir) return { ok: false };
  const base = defaultKillSoundsSettings();
  const s = settings && typeof settings === 'object' ? settings : {};
  const events = { ...base.events, ...(s.events && typeof s.events === 'object' ? s.events : {}) };
  const workshopIds = Array.isArray(s.workshopIds) && s.workshopIds.length
    ? s.workshopIds.map((x) => String(x).trim()).filter(Boolean)
    : base.workshopIds;
  const payloadObj = {
    enabled: !!s.enabled,
    workshopIds,
    intensity: ['low', 'med', 'high'].includes(String(s.intensity || ''))
      ? String(s.intensity)
      : 'med',
    soundEventFile: String(s.soundEventFile || base.soundEventFile),
    events: {
      kill: String(events.kill || ''),
      headshot: String(events.headshot || ''),
      firstBlood: String(events.firstBlood || ''),
      knife: String(events.knife || ''),
      doubleKill: String(events.doubleKill || ''),
      tripleKill: String(events.tripleKill || ''),
      killstreak: String(events.killstreak || ''),
    },
  };
  fs.mkdirSync(cfgDir, { recursive: true });
  const payload = JSON.stringify(payloadObj, null, 2);
  const file = path.join(cfgDir, 'sf_pm_sounds.json');
  fs.writeFileSync(file, payload, 'utf8');
  try {
    const gameRoot = path.dirname(path.dirname(cfgDir));
    if (path.basename(path.dirname(cfgDir)) === 'csgo') {
      const altDir = path.join(gameRoot, 'cfg');
      fs.mkdirSync(altDir, { recursive: true });
      fs.writeFileSync(path.join(altDir, 'sf_pm_sounds.json'), payload, 'utf8');
      // MultiAddonManager cfg ao lado do csgo
      if (payloadObj.enabled) {
        writeMultiAddonManagerCfg(path.dirname(cfgDir), payloadObj.workshopIds);
      } else {
        writeMultiAddonManagerCfg(path.dirname(cfgDir), []);
      }
    }
  } catch {
    /* ignore */
  }
  return { ok: true, file, settings: payloadObj };
}

/** Fila de comandos para o plugin (Server.ExecuteCommand) — stdin do dedicated CS2 não funciona. */
function writeCmdFile(cfgDir, cmds, seq) {
  if (!cfgDir) return { ok: false, error: 'no_cfg' };
  const list = (Array.isArray(cmds) ? cmds : [cmds])
    .map((c) => String(c || '').trim())
    .filter(Boolean);
  if (!list.length) return { ok: false, error: 'empty' };
  const id = seq != null ? Number(seq) : Date.now();
  const payload = JSON.stringify({ seq: id, cmds: list, at: Date.now() });
  fs.mkdirSync(cfgDir, { recursive: true });
  const file = path.join(cfgDir, 'sf_pm_cmd.json');
  writeFileRetry(file, payload);
  try {
    const gameRoot = path.dirname(path.dirname(cfgDir));
    if (path.basename(path.dirname(cfgDir)) === 'csgo') {
      const altDir = path.join(gameRoot, 'cfg');
      fs.mkdirSync(altDir, { recursive: true });
      writeFileRetry(path.join(altDir, 'sf_pm_cmd.json'), payload);
    }
  } catch {
    /* ignore */
  }
  return { ok: true, file, seq: id, cmds: list };
}

function writeFileRetry(file, payload) {
  let last;
  for (let i = 0; i < 12; i++) {
    try {
      fs.writeFileSync(file, payload, 'utf8');
      return;
    } catch (e) {
      last = e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    }
  }
  throw last;
}

/** No-ops: Steam gameinfo nunca é patchado. Mantidos por compatibilidade de callers. */
function patchGameinfo() {
  return { ok: true, patched: false, skipped: true, restore: () => ({ ok: true }) };
}
async function patchGameinfoAsync() {
  return { ok: true, patched: false, skipped: true, restore: async () => ({ ok: true }) };
}
function restoreGameinfo() {
  return { ok: true, skipped: true };
}
async function restoreGameinfoAsync() {
  return { ok: true, skipped: true };
}
function closeCs2ClientProcesses() {
  return Promise.resolve({ ok: true, skipped: true });
}

module.exports = {
  ensureServerMods,
  ensureCs2Overlay,
  patchGameinfo,
  patchGameinfoAsync,
  restoreGameinfo,
  restoreGameinfoAsync,
  closeCs2ClientProcesses,
  writeTeamsFile,
  writeAdminFile,
  writeSoundsFile,
  writeMultiAddonManagerCfg,
  writeCmdFile,
  pluginDllPath,
  modsReady,
  buildPatchedGameinfo,
  gameinfoPath,
  defaultKillSoundsSettings,
  QUAKE_WORKSHOP_ID,
};
