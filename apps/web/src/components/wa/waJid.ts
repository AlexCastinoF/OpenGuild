/** Digitos de telefone a partir de JID PN (vazio para @lid / grupos). */
export function waPhoneDigits(jidOrPhone?: string | null): string {
  const s = String(jidOrPhone || '').trim();
  if (!s || s.includes('@lid') || s.includes('@g.us') || s.includes('@broadcast')) return '';
  const user = (s.split('@')[0] || '').split(':')[0];
  const digits = user.replace(/\D/g, '');
  return digits.length >= 10 ? digits : '';
}

function normJid(jid: string): string {
  return String(jid || '')
    .trim()
    .replace(/:\d+@/, '@');
}

/**
 * Compara conversa aberta com JID do evento SSE (LID ↔ PN / device suffix).
 * Nunca usa openPhone como candidato do evento — isso fazia qualquer msg “bater”.
 */
export function sameWaChat(
  openJid: string | null | undefined,
  eventJid: string | null | undefined,
  opts?: { openPhone?: string | null; eventAlt?: string | null },
): boolean {
  const a = String(openJid || '').trim();
  const b = String(eventJid || '').trim();
  if (!a || !b) return false;

  // Grupo nunca é a mesma DM (e vice-versa)
  const aGroup = a.includes('@g.us');
  const bGroup = b.includes('@g.us');
  if (aGroup !== bGroup) return false;

  if (a === b || normJid(a) === normJid(b)) return true;

  const eventCandidates = [b, opts?.eventAlt]
    .map((x) => String(x || '').trim())
    .filter(Boolean);

  for (const c of eventCandidates) {
    if (a === c || normJid(a) === normJid(c)) return true;
  }

  const openDigits = waPhoneDigits(a) || waPhoneDigits(opts?.openPhone);
  if (!openDigits) return false;

  for (const c of eventCandidates) {
    if (c.includes('@g.us')) continue;
    const d = waPhoneDigits(c);
    if (d && d === openDigits) return true;
  }

  return false;
}
