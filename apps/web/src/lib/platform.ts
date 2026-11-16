/**
 * Unified platform detection utility for Tauri desktop vs Browser web.
 */
export function isTauriApp(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
    sfDesktop?: unknown;
  };
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__ || w.sfDesktop);
}
