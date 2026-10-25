/**
 * Publica um pack de partida (DLLs + manifest + catálogo) em match-packs/<version>/.
 *
 * Uso:
 *   node apps/desktop/scripts/publish-match-pack.js [version] [--changelog "texto"]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..', '..', '..');
const desktopRoot = path.join(__dirname, '..');
const pluginDir = path.join(desktopRoot, 'resources', 'cs2-plugin');
const assignDll = path.join(pluginDir, 'SfAssignTeams.dll');
const killDll = path.join(pluginDir, 'SfKillSounds.dll');
const packsRoot = path.join(root, 'match-packs');

function parseArgs(argv) {
  const out = { version: '', changelog: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--changelog') {
      out.changelog = String(argv[++i] || '');
    } else {
      rest.push(argv[i]);
    }
  }
  out.version = String(rest[0] || '').trim() || '1.4.2';
  return out;
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function defaultChangelog(version) {
  return [
    'Novidades',
    '✅ Anúncio de kill no chat (vermelho)',
    '✅ Tags: First Blood, Headshot, No-Scope, Wallbang',
    '✅ Contagem de tiros por eliminação',
    '✅ Sons Quake mantidos',
  ].join('\n');
}

function defaultDefaults() {
  return {
    mp_startmoney: 800,
    mp_maxmoney: 65000,
    mp_roundtime: 1.92,
    mp_freezetime: 15,
    mp_buytime: 20,
    mp_warmuptime: 60,
    cash_player_killed_enemy_default: 300,
    cash_team_winner_bonus: 4000,
    cash_team_loser_bonus: 1400,
    mp_afterroundmoney: 0,
    mp_limitteams: 0,
    mp_spectators: 1,
    mp_autoteambalance: 0,
  };
}

function soundsCatalog() {
  return {
    workshopId: '3461824328',
    soundEventFile: 'soundevents/soundevents_quakesounds.vsndevts',
    events: [
      { key: 'kill', label: 'Kill', default: 'QuakeSoundsD.Humiliation' },
      { key: 'headshot', label: 'Headshot', default: 'QuakeSoundsD.Headshot' },
      { key: 'firstBlood', label: 'First Blood', default: 'QuakeSoundsD.Firstblood' },
      { key: 'knife', label: 'Faca', default: 'QuakeSoundsD.Haha' },
      { key: 'doubleKill', label: 'Double Kill', default: 'QuakeSoundsD.Doublekill' },
      { key: 'tripleKill', label: 'Triple Kill', default: 'QuakeSoundsD.Triplekill' },
      { key: 'killstreak', label: 'Killstreak', default: 'QuakeSoundsD.Killingspree' },
    ],
    sounds: [
      'QuakeSoundsD.Humiliation',
      'QuakeSoundsD.Headshot',
      'QuakeSoundsD.Firstblood',
      'QuakeSoundsD.Haha',
      'QuakeSoundsD.Doublekill',
      'QuakeSoundsD.Triplekill',
      'QuakeSoundsD.Killingspree',
      'QuakeSoundsD.Multikill',
      'QuakeSoundsD.Dominating',
      'QuakeSoundsD.Rampage',
      'QuakeSoundsD.Unstoppable',
      'QuakeSoundsD.Godlike',
      'QuakeSoundsD.Wickedsick',
      'QuakeSoundsD.Holyshit',
      'QuakeSoundsD.Impressive',
      'QuakeSoundsD.Perfect',
    ],
  };
}

function rebuildIndex() {
  const versions = [];
  if (!fs.existsSync(packsRoot)) return { latest: null, versions: [] };
  for (const name of fs.readdirSync(packsRoot)) {
    if (name === 'index.json') continue;
    const dir = path.join(packsRoot, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const manPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manPath)) continue;
    try {
      const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
      const changelog = String(man.changelog || '');
      const summaryLine =
        changelog
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l.startsWith('✅') || l.startsWith('- ')) || '';
      const changelogSummary = summaryLine
        ? summaryLine.replace(/^(✅|-)\s*/, '').trim()
        : changelog.split(/\r?\n/).filter(Boolean)[0] || `Pack ${name}`;
      versions.push({
        version: man.version || name,
        publishedAt: man.publishedAt || null,
        changelogSummary,
        sha256: man.sha256 || null,
        size: man.size || null,
      });
    } catch {
      /* ignore */
    }
  }
  versions.sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }));
  const index = {
    latest: versions[0]?.version || null,
    versions,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(packsRoot, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
  return index;
}

function main() {
  const { version, changelog } = parseArgs(process.argv.slice(2));
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('Versão inválida (use x.y.z):', version);
    process.exit(1);
  }
  if (!fs.existsSync(assignDll)) {
    console.error('DLL em falta. Compila: npm run build:cs2-plugin -w @steamfarm/desktop');
    console.error(assignDll);
    process.exit(1);
  }

  const destDir = path.join(packsRoot, version);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(assignDll, path.join(destDir, 'SfAssignTeams.dll'));
  const files = ['SfAssignTeams.dll', 'sounds-catalog.json'];
  if (fs.existsSync(killDll)) {
    fs.copyFileSync(killDll, path.join(destDir, 'SfKillSounds.dll'));
    files.splice(1, 0, 'SfKillSounds.dll');
  } else {
    console.warn('[publish-match-pack] aviso: SfKillSounds.dll em falta');
  }
  fs.writeFileSync(
    path.join(destDir, 'sounds-catalog.json'),
    JSON.stringify(soundsCatalog(), null, 2),
    'utf8',
  );

  const st = fs.statSync(path.join(destDir, 'SfAssignTeams.dll'));
  const hash = sha256File(path.join(destDir, 'SfAssignTeams.dll'));
  const manifest = {
    version,
    minDesktopVersion: '1.2.39',
    publishedAt: new Date().toISOString(),
    changelog: changelog.trim() || defaultChangelog(version),
    defaults: defaultDefaults(),
    dll: 'SfAssignTeams.dll',
    files,
    features: { killSounds: fs.existsSync(path.join(destDir, 'SfKillSounds.dll')) },
    workshopIds: ['3461824328'],
    size: st.size,
    sha256: hash,
  };
  fs.writeFileSync(path.join(destDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  const index = rebuildIndex();
  console.log('[publish-match-pack] ok', version, `files=${files.join(',')}`, `sha256=${hash.slice(0, 12)}…`);
  console.log('[publish-match-pack] latest=', index.latest);
  console.log('[publish-match-pack] dir=', destDir);
}

main();
