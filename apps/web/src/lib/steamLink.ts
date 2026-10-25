/** Inicia vínculo Steam OpenID — no desktop abre o browser externo (não trava a app). */

export type SteamLinkStartResult = { mode: 'external' | 'navigate' };

const PENDING_KEY = 'sf_steam_link_pending';

export function markSteamLinkPending() {
  try {
    localStorage.setItem(PENDING_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

export function clearSteamLinkPending() {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}

export function isSteamLinkPending(maxAgeMs = 15 * 60 * 1000): boolean {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return false;
    const at = Number(raw);
    if (!Number.isFinite(at) || Date.now() - at > maxAgeMs) {
      localStorage.removeItem(PENDING_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function startSteamLink(
  next = '/comunidade',
): Promise<SteamLinkStartResult> {
  const nextPath = next.startsWith('/') ? next : '/comunidade';

  const res = await fetch(`/api/steam/link-url?next=${encodeURIComponent(nextPath)}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  const data = (await res.json().catch(() => null)) as
    | { ok?: boolean; url?: string; error?: string }
    | null;
  if (!res.ok || !data?.url) {
    throw new Error(
      data?.error ||
        (res.status === 401 || res.status === 403
          ? 'Sessão expirada — faz login outra vez e tenta conectar a Steam.'
          : 'Falha ao iniciar ligação Steam.'),
    );
  }

  markSteamLinkPending();

  if (typeof window !== 'undefined' && window.sfDesktop?.openExternal) {
    await window.sfDesktop.openExternal(data.url);
    return { mode: 'external' };
  }

  // Browser: ir direto ao OpenID (evita /steam/link se o nginx não fizer proxy)
  window.location.assign(data.url);
  return { mode: 'navigate' };
}
