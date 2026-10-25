/**
 * Packs remotos de partida: DLL SfAssignTeams + manifest → cs2-plugin-override.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION_RE = /^\d+\.\d+\.\d+$/;

function overrideDir(userDataPath) {
  return path.join(String(userDataPath || ''), 'cs2-plugin-override');
}

function cacheDir(userDataPath, version) {
  return path.join(String(userDataPath || ''), 'match-packs', version);
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function bundledPluginDir() {
  const candidates = [
    path.join(__dirname, 'resources', 'cs2-plugin'),
    process.resourcesPath ? path.join(process.resourcesPath, 'cs2-plugin') : '',
    path.join(__dirname, '..', '..', 'match-packs'),
  ].filter(Boolean);
  return candidates;
}

function hydrateFromBundled(cache, version) {
  const destDll = path.join(cache, 'SfAssignTeams.dll');
  const destKill = path.join(cache, 'SfKillSounds.dll');
  const destCat = path.join(cache, 'sounds-catalog.json');
  const destMan = path.join(cache, 'manifest.json');

  const packRoots = [
    path.join(__dirname, '..', '..', 'match-packs', version),
    path.join(__dirname, '..', '..', '..', 'match-packs', version),
    path.join(__dirname, 'resources', 'match-packs', version),
    process.resourcesPath ? path.join(process.resourcesPath, 'match-packs', version) : '',
  ].filter(Boolean);

  let srcDir = '';
  for (const dir of packRoots) {
    if (fs.existsSync(path.join(dir, 'SfAssignTeams.dll'))) {
      srcDir = dir;
      break;
    }
  }

  const copyIf = (from, to) => {
    if (!from || !fs.existsSync(from)) return false;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    return true;
  };

  if (srcDir) {
    copyIf(path.join(srcDir, 'SfAssignTeams.dll'), destDll);
    copyIf(path.join(srcDir, 'SfKillSounds.dll'), destKill);
    copyIf(path.join(srcDir, 'sounds-catalog.json'), destCat);
    const man = readJsonSafe(path.join(srcDir, 'manifest.json')) || {
      version,
      dll: 'SfAssignTeams.dll',
      files: ['SfAssignTeams.dll'],
    };
    fs.writeFileSync(destMan, JSON.stringify(man, null, 2), 'utf8');
    return { ok: true, manifest: man, source: 'local-pack' };
  }

  let bundledDll = '';
  for (const dir of bundledPluginDir()) {
    const p = path.join(dir, 'SfAssignTeams.dll');
    if (fs.existsSync(p)) {
      bundledDll = p;
      copyIf(path.join(dir, 'SfKillSounds.dll'), destKill);
      copyIf(path.join(dir, 'sounds-catalog.json'), destCat);
      break;
    }
  }
  if (!bundledDll) return { ok: false };
  copyIf(bundledDll, destDll);
  const st = fs.statSync(destDll);
  const man = {
    version,
    dll: 'SfAssignTeams.dll',
    files: ['SfAssignTeams.dll', 'SfKillSounds.dll', 'sounds-catalog.json'],
    size: st.size,
    changelog: `Pack ${version} (cópia local — servidor indisponível)`,
  };
  fs.writeFileSync(destMan, JSON.stringify(man, null, 2), 'utf8');
  return { ok: true, manifest: man, source: 'bundled' };
}

function listInstalled(userDataPath) {
  const root = path.join(String(userDataPath || ''), 'match-packs');
  const versions = [];
  if (!fs.existsSync(root)) return { versions, active: null };
  for (const name of fs.readdirSync(root)) {
    if (!VERSION_RE.test(name)) continue;
    const dll = path.join(root, name, 'SfAssignTeams.dll');
    if (fs.existsSync(dll)) versions.push(name);
  }
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const active = readJsonSafe(path.join(overrideDir(userDataPath), 'active-version.json'));
  return { versions, active: active?.version || null };
}

/**
 * @param {object} opts
 * @param {string} opts.version
 * @param {string} opts.userDataPath
 * @param {string} opts.serverUrl
 * @param {(pathname: string) => Promise<{ status: number, buffer?: Buffer, data?: any, error?: string }>} opts.fetchBinary
 * @param {(pathname: string) => Promise<{ status: number, data?: any }>} opts.fetchJson
 */
async function ensurePack(opts) {
  const version = String(opts?.version || '').trim();
  const userDataPath = String(opts?.userDataPath || '').trim();
  if (!VERSION_RE.test(version)) {
    return { ok: false, error: 'invalid_version' };
  }
  if (!userDataPath) {
    return { ok: false, error: 'no_userdata' };
  }

  const cache = cacheDir(userDataPath, version);
  fs.mkdirSync(cache, { recursive: true });
  const manPath = path.join(cache, 'manifest.json');

  let manifest = readJsonSafe(manPath);
  const needManifest = !manifest || manifest.version !== version;
  if (needManifest) {
    const { status, data } = await opts.fetchJson(`/api/match-packs/${version}`);
    if (status === 401 || status === 403) {
      const local = hydrateFromBundled(cache, version);
      if (!local.ok) return { ok: false, error: 'auth_required', status };
      manifest = local.manifest;
    } else if (status < 200 || status >= 300 || !data || data.error === 'Resposta inválida do servidor') {
      const local = hydrateFromBundled(cache, version);
      if (!local.ok) {
        return { ok: false, error: data?.error || `manifest_http_${status}`, status };
      }
      manifest = local.manifest;
    } else {
      manifest = data;
      fs.writeFileSync(manPath, JSON.stringify(manifest, null, 2), 'utf8');
    }
  }

  const packFiles = Array.isArray(manifest?.files) && manifest.files.length
    ? manifest.files.map((f) => String(f))
    : ['SfAssignTeams.dll'];
  if (!packFiles.includes('SfAssignTeams.dll')) packFiles.unshift('SfAssignTeams.dll');

  for (const fileName of packFiles) {
    if (!/^(SfAssignTeams|SfKillSounds)\.dll$/i.test(fileName) && fileName !== 'sounds-catalog.json') {
      continue;
    }
    const dest = path.join(cache, fileName);
    let need = !fs.existsSync(dest);
    if (!need && fileName === 'SfAssignTeams.dll' && manifest?.size) {
      try {
        if (fs.statSync(dest).size !== Number(manifest.size)) need = true;
      } catch {
        need = true;
      }
    }
    if (!need && fileName === 'SfAssignTeams.dll' && manifest?.sha256) {
      try {
        if (sha256File(dest) !== String(manifest.sha256).toLowerCase()) need = true;
      } catch {
        need = true;
      }
    }
    if (!need) continue;

    const bin = await opts.fetchBinary(`/api/match-packs/${version}/${fileName}`);
    if (bin.status === 401 || bin.status === 403) {
      return { ok: false, error: 'auth_required', status: bin.status };
    }
    if (bin.status < 200 || bin.status >= 300 || !bin.buffer?.length) {
      // SfKillSounds opcional em packs antigos
      if (fileName !== 'SfAssignTeams.dll') continue;
      return {
        ok: false,
        error: bin.error || `dll_http_${bin.status}`,
        status: bin.status,
      };
    }
    const tmp = `${dest}.part`;
    fs.writeFileSync(tmp, bin.buffer);
    if (fileName === 'SfAssignTeams.dll' && manifest?.sha256) {
      const got = sha256File(tmp);
      if (got !== String(manifest.sha256).toLowerCase()) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        return { ok: false, error: 'sha256_mismatch', expected: manifest.sha256, got };
      }
    }
    fs.renameSync(tmp, dest);
  }

  const ovDir = overrideDir(userDataPath);
  fs.mkdirSync(ovDir, { recursive: true });
  const dllPath = path.join(cache, 'SfAssignTeams.dll');
  const ovDll = path.join(ovDir, 'SfAssignTeams.dll');

  // Hotfix / DLL local mais nova: nunca deixar o pack remoto antigo sobrescrever.
  let hotfixed = false;
  try {
    const bundledCandidates = [
      path.join(__dirname, 'resources', 'cs2-plugin', 'SfAssignTeams.dll'),
      process.resourcesPath
        ? path.join(process.resourcesPath, 'cs2-plugin', 'SfAssignTeams.dll')
        : '',
    ].filter(Boolean);
    let bundled = '';
    let bundledSize = 0;
    let bundledMtime = 0;
    for (const p of bundledCandidates) {
      if (!fs.existsSync(p)) continue;
      const st = fs.statSync(p);
      if (st.mtimeMs >= bundledMtime) {
        bundled = p;
        bundledSize = st.size;
        bundledMtime = st.mtimeMs;
      }
    }
    // Se o bundle do Desktop for mais novo/maior que o pack descarregado, usa-o no cache
    if (bundled && fs.existsSync(dllPath)) {
      const ck = fs.statSync(dllPath);
      if (bundledSize > ck.size || bundledMtime > ck.mtimeMs + 1000) {
        fs.copyFileSync(bundled, dllPath);
      }
    } else if (bundled && !fs.existsSync(dllPath)) {
      fs.copyFileSync(bundled, dllPath);
    }

    if (fs.existsSync(ovDll) && fs.existsSync(dllPath)) {
      const ov = fs.statSync(ovDll);
      const ck = fs.statSync(dllPath);
      if (ov.size > ck.size || ov.mtimeMs > ck.mtimeMs + 5000) {
        hotfixed = true;
      }
    }
  } catch {
    /* ignore */
  }

  if (!hotfixed) {
    fs.copyFileSync(dllPath, ovDll);
  }
  const killSrc = path.join(cache, 'SfKillSounds.dll');
  if (fs.existsSync(killSrc)) {
    fs.copyFileSync(killSrc, path.join(ovDir, 'SfKillSounds.dll'));
  }
  const catSrc = path.join(cache, 'sounds-catalog.json');
  if (fs.existsSync(catSrc)) {
    fs.copyFileSync(catSrc, path.join(ovDir, 'sounds-catalog.json'));
  }

  const ovSize = fs.statSync(ovDll).size;
  fs.writeFileSync(path.join(ovDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(ovDir, 'active-version.json'),
    JSON.stringify(
      {
        version,
        appliedAt: new Date().toISOString(),
        sha256: hotfixed ? null : manifest?.sha256 || null,
        size: ovSize,
        hotfixed: hotfixed || undefined,
        note: hotfixed ? 'local override DLL kept (newer than pack)' : undefined,
      },
      null,
      2,
    ),
    'utf8',
  );

  return {
    ok: true,
    version,
    pluginVersion: version,
    dllPath: ovDll,
    bytes: ovSize,
    hotfixed,
    defaults: manifest?.defaults || {},
    changelog: manifest?.changelog || '',
    minDesktopVersion: manifest?.minDesktopVersion || null,
    cached: true,
  };
}

module.exports = {
  ensurePack,
  listInstalled,
  overrideDir,
  VERSION_RE,
};
