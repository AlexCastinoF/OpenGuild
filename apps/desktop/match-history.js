/**
 * Histórico local de partidas privadas (Electron userData).
 */
const fs = require('fs');
const path = require('path');

let storePath = '';

function configure({ userDataPath }) {
  storePath = path.join(String(userDataPath || ''), 'private-match-history.json');
}

function readAll() {
  try {
    if (!storePath || !fs.existsSync(storePath)) return [];
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    return Array.isArray(raw?.matches) ? raw.matches : [];
  } catch {
    return [];
  }
}

function writeAll(matches) {
  if (!storePath) return { ok: false, error: 'no_path' };
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify({ matches: matches.slice(0, 80), updatedAt: Date.now() }, null, 2),
      'utf8',
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function list(limit = 30) {
  const n = Math.min(80, Math.max(1, Number(limit) || 30));
  return { ok: true, matches: readAll().slice(0, n) };
}

function push(entry) {
  const list0 = readAll();
  const row = {
    id: String(entry?.id || `pm_${Date.now()}`),
    name: String(entry?.name || 'Partida'),
    mode: String(entry?.mode || 'host_listen'),
    map: String(entry?.map || ''),
    format: String(entry?.format || ''),
    scoreCt: Number(entry?.scoreCt) || 0,
    scoreT: Number(entry?.scoreT) || 0,
    players: Array.isArray(entry?.players) ? entry.players : [],
    stats: Array.isArray(entry?.stats) ? entry.stats : [],
    endedAt: Number(entry?.endedAt) || Date.now(),
    connect: entry?.connect || null,
  };
  list0.unshift(row);
  writeAll(list0);
  return { ok: true, match: row };
}

function clear() {
  writeAll([]);
  return { ok: true };
}

module.exports = { configure, list, push, clear };
