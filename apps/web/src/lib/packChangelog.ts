/** Changelog amigável de match packs (sem jargão técnico). */

export type PackChangeItem = {
  kind: 'add' | 'remove' | 'note';
  text: string;
};

const SKIP_LINE =
  /^(match\s*pack\s|novidades|melhorias|recursos|changelog|sfkillsounds|sfassignteams)/i;

/**
 * Converte o texto do manifesto em itens com ✅ / ❌.
 * Aceita linhas com emoji, `- ` ou `+ `.
 */
export function parsePackChangelog(raw: string): PackChangeItem[] {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const items: PackChangeItem[] = [];
  for (const line of lines) {
    if (SKIP_LINE.test(line)) continue;

    const emojiAdd = /^(✅|✔️|☑|✔)\s*/.test(line);
    const emojiRemove = /^(❌|✖️|☒|✖|❎)\s*/.test(line);
    const bullet = /^[-*•+]\s+/.test(line);

    let text = line
      .replace(/^(✅|✔️|☑|✔|❌|✖️|☒|✖|❎)\s*/, '')
      .replace(/^[-*•+]\s+/, '')
      .trim();
    if (!text) continue;

    const lower = text.toLowerCase();
    if (emojiRemove || /^(removido|removida|removidos)\b/.test(lower)) {
      items.push({
        kind: 'remove',
        text: text.replace(/^(removido|removida|removidos)\s*[:–-]?\s*/i, ''),
      });
      continue;
    }
    if (emojiAdd || bullet || /^(novo|nova|adicionad|melhor)/i.test(lower)) {
      items.push({ kind: 'add', text });
      continue;
    }
    items.push({ kind: 'note', text });
  }
  return items;
}

export function packChangelogSummary(raw: string, fallback = ''): string {
  const first = parsePackChangelog(raw).find((i) => i.kind === 'add' || i.kind === 'note');
  return first?.text || fallback;
}
