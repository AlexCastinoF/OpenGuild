/** Copia NSIS + latest.yml para desktop-releases/ e feed Flask legado. */
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
const destLocal = path.join(__dirname, '..', '..', '..', 'desktop-releases');
const destFlask = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'archi-steam-farm-py',
  'asf_py',
  'static',
  'desktop',
);

if (!fs.existsSync(dist)) {
  console.error('dist/ não encontrado — rode npm run dist:exe antes');
  process.exit(1);
}

const names = fs.readdirSync(dist);
const yml = names.find((n) => /^latest.*\.yml$/i.test(n));
let exe = '';
if (yml) {
  const meta = fs.readFileSync(path.join(dist, yml), 'utf8');
  const pathMatch = meta.match(/^path:\s*(.+)$/m);
  if (pathMatch) exe = pathMatch[1].trim().replace(/^["']|["']$/g, '');
}
if (!exe || !names.includes(exe)) {
  const exes = names.filter(
    (n) => n.endsWith('.exe') && /SteamFarm|Comunidade/i.test(n) && !/portable/i.test(n),
  );
  exe = exes.sort().reverse()[0] || '';
}

if (!yml || !exe) {
  console.error('latest.yml ou .exe não encontrados em dist/');
  console.error('arquivos:', names.join(', '));
  process.exit(1);
}

const files = [yml, exe];
const blockmap = `${exe}.blockmap`;
if (names.includes(blockmap)) files.push(blockmap);

for (const dest of [destLocal, destFlask]) {
  fs.mkdirSync(dest, { recursive: true });
  for (const n of files) {
    fs.copyFileSync(path.join(dist, n), path.join(dest, n));
    console.log('copiado →', dest, n);
  }
}

console.log('OK →', destLocal);
console.log('OK →', destFlask);
