/**
 * Garante rustdesk.exe oficial em resources/rustdesk/ (não versionar o binário).
 * Fonte: https://github.com/rustdesk/rustdesk/releases
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const VERSION = '1.4.9';
const URL = `https://github.com/rustdesk/rustdesk/releases/download/${VERSION}/rustdesk-${VERSION}-x86_64.exe`;
const destDir = path.join(__dirname, '..', 'resources', 'rustdesk');
const dest = path.join(destDir, 'rustdesk.exe');

function download(url, out) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(out);
    const go = (u, redirects = 0) => {
      https
        .get(u, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (redirects > 8) {
              reject(new Error('too_many_redirects'));
              return;
            }
            go(res.headers.location, redirects + 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
        })
        .on('error', reject);
    };
    go(url);
  });
}

async function main() {
  fs.mkdirSync(destDir, { recursive: true });
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) {
    console.log('[rustdesk] already present', dest);
    return;
  }
  console.log('[rustdesk] downloading', URL);
  const tmp = `${dest}.tmp`;
  try {
    await download(URL, tmp);
    fs.renameSync(tmp, dest);
    console.log('[rustdesk] ok', dest, fs.statSync(dest).size);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    console.warn('[rustdesk] download failed:', e?.message || e);
    // Não falha o postinstall — dist pode baixar depois
  }
}

main();
