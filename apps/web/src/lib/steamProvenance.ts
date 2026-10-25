/** Parseia blocos de descrição Steam (HTML cru → texto + adesivos). */

export type SteamSticker = { src: string; title: string };

export type ParsedProvenance = {
  texts: string[];
  stickers: SteamSticker[];
};

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export function stripSteamHtml(raw: string): string {
  return decodeEntities(
    String(raw || '')
      .replace(/<\s*br\s*\/?\s*>/gi, '\n')
      .replace(/<\/\s*p\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

export function parseSteamProvenance(lines: string[] | undefined | null): ParsedProvenance {
  const stickers: SteamSticker[] = [];
  const texts: string[] = [];
  const seenSrc = new Set<string>();

  for (const raw of lines || []) {
    const line = String(raw || '');
    if (!line.trim()) continue;

    const imgRe =
      /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*(?:\btitle=["']([^"']*)["'])?[^>]*>/gi;
    let m: RegExpExecArray | null;
    let hadImg = false;
    while ((m = imgRe.exec(line))) {
      hadImg = true;
      const src = m[1];
      const title = decodeEntities(m[2] || 'Adesivo');
      if (src && !seenSrc.has(src + title)) {
        seenSrc.add(src + title);
        stickers.push({ src, title });
      }
    }

    // Remove bloco de adesivos e tags; mantém texto útil (descrição / coleção)
    const withoutStickers = line
      .replace(/<div\b[^>]*sticker_info[\s\S]*?<\/div>/gi, ' ')
      .replace(/<center[\s\S]*?<\/center>/gi, ' ');
    const cleaned = stripSteamHtml(withoutStickers);
    if (!cleaned) continue;
    // Evita repetir a lista textual "Adesivo: A, B, C" quando já temos imgs
    if (hadImg && /^Adesivo\s*:/i.test(cleaned)) continue;
    if (!texts.includes(cleaned)) texts.push(cleaned);
  }

  return { texts, stickers };
}
