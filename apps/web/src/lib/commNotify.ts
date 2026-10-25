/**
 * Notificações do browser (paridade Flask community_notify.js).
 * Prefs: steamfarm-notify-enabled + steamfarm-notify-prefs (UI de Configurações).
 *
 * Mute só vale com a aba visível: se o usuário minimiza / troca de aba,
 * mensagens do canal aberto também geram toast.
 */

import { useBrandStore } from '../store/brand';

export type NotifyKind =
  | 'community.member_join'
  | 'community.text_message'
  | 'community.screen_share'
  | 'community.dm'
  | 'community.match_found'
  | 'community.match_connect'
  | 'community.remote_access'
  | 'whatsapp.dm'
  | 'whatsapp.group';

export type NotifyOpts = {
  kind: NotifyKind;
  threadKey: string;
  title: string;
  body?: string;
  icon?: string;
  onClick?: () => void;
};

const ENABLED_KEY = 'steamfarm-notify-enabled';
const PREFS_KEY = 'steamfarm-notify-prefs';

const viewingThreads = new Set<string>();
const pending = new Map<string, { timer: number; count: number; opts: NotifyOpts }>();
const notifRefs = new Map<string, Notification>();
const screenShareNotified = new Set<string>();

let visibilityBound = false;

function brandLabel(): string {
  try {
    const s = useBrandStore.getState();
    return (s.short_name || s.name || '').trim() || 'App';
  } catch {
    return 'App';
  }
}

function brandIcon(): string | undefined {
  try {
    const logo = (useBrandStore.getState().logo_url || useBrandStore.getState().favicon_url || '').trim();
    if (logo) {
      if (/^https?:\/\//i.test(logo)) return logo;
      return new URL(logo, location.origin).href;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Garante que o toast mostre a marca (evita "Comunidade · …" / títulos sem produto). */
export function withBrandTitle(title: string): string {
  const brand = brandLabel();
  let t = String(title || '').trim();
  if (!t) return brand;
  t = t.replace(/^Comunidade\s*[·•|\-–—]\s*/i, '');
  t = t.replace(/^SteamFarm(?:\s+Comunidade)?\s*[·•|\-–—]\s*/i, '');
  if (t.toLowerCase().startsWith(brand.toLowerCase())) return t;
  return `${brand} · ${t}`;
}

function prefsEnabled(): boolean {
  return localStorage.getItem(ENABLED_KEY) !== '0';
}

function loadPrefMap(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

function kindEnabled(kind: NotifyKind): boolean {
  if (!prefsEnabled()) return false;
  return loadPrefMap()[kind] !== false;
}

function pageIsHidden(): boolean {
  try {
    return document.visibilityState === 'hidden' || document.hidden === true;
  } catch {
    return false;
  }
}

/** Canal/thread aberto só silencia com a aba em foco. */
function threadMuted(threadKey: string): boolean {
  if (pageIsHidden()) return false;
  return viewingThreads.has(threadKey);
}

function ensureVisibilityHook() {
  if (visibilityBound || typeof document === 'undefined') return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (pageIsHidden()) return;
    // Voltou à aba: fecha toasts dos threads que estão abertos na UI
    for (const key of viewingThreads) {
      cancelPending(key);
      closeNotif(key);
    }
  });
}

function cancelPending(threadKey: string) {
  const row = pending.get(threadKey);
  if (row?.timer) window.clearTimeout(row.timer);
  pending.delete(threadKey);
}

function closeNotif(threadKey: string) {
  try {
    notifRefs.get(threadKey)?.close();
  } catch {
    /* ignore */
  }
  notifRefs.delete(threadKey);
}

export function setViewingThread(threadKey: string | null, viewing: boolean) {
  ensureVisibilityHook();
  if (!threadKey) return;
  if (viewing) {
    viewingThreads.add(threadKey);
    if (!pageIsHidden()) {
      cancelPending(threadKey);
      closeNotif(threadKey);
    }
  } else {
    viewingThreads.delete(threadKey);
  }
}

function focusAppWindow() {
  try {
    (
      window as unknown as { sfDesktop?: { focusWindow?: () => void } }
    ).sfDesktop?.focusWindow?.();
  } catch {
    /* ignore */
  }
  try {
    window.focus();
  } catch {
    /* ignore */
  }
}

function defaultIcon(): string | undefined {
  try {
    const link = document.querySelector<HTMLLinkElement>('link[rel*="icon"]');
    if (link?.href) return link.href;
  } catch {
    /* ignore */
  }
  return undefined;
}

function showNow(threadKey: string, opts: NotifyOpts & { body?: string }) {
  ensureVisibilityHook();
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  if (!kindEnabled(opts.kind)) return;
  if (threadMuted(threadKey)) return;

  closeNotif(threadKey);
  try {
    const n = new Notification(withBrandTitle(opts.title), {
      body: opts.body || '',
      icon: opts.icon || brandIcon() || defaultIcon(),
      tag: threadKey,
      // Ajuda o Windows a não engolir o toast quando a aba acabou de ir para background
      requireInteraction: false,
    });
    notifRefs.set(threadKey, n);
    n.onclick = () => {
      setViewingThread(threadKey, true);
      cancelPending(threadKey);
      closeNotif(threadKey);
      focusAppWindow();
      opts.onClick?.();
      n.close();
    };
  } catch {
    /* ignore */
  }
}

export function pushNotify(opts: NotifyOpts) {
  ensureVisibilityHook();
  if (!opts?.threadKey || !opts?.kind) return;
  if (!kindEnabled(opts.kind)) return;
  if (threadMuted(opts.threadKey)) return;
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;

  const prev = pending.get(opts.threadKey);
  if (prev?.timer) window.clearTimeout(prev.timer);
  const count = (prev?.count || 0) + 1;
  const merged = { ...opts };

  const timer = window.setTimeout(() => {
    pending.delete(opts.threadKey);
    if (threadMuted(opts.threadKey)) return;
    const body = count > 1 ? `${count} mensagens novas` : merged.body || '';
    showNow(opts.threadKey, { ...merged, body });
  }, 700);

  pending.set(opts.threadKey, { timer, count, opts: merged });
}

/** Dispara um toast imediato (teste de permissão / diagnóstico). Ignora prefs de tipo. */
export function pushNotifyNow(opts: NotifyOpts) {
  ensureVisibilityHook();
  if (!opts?.threadKey || !opts?.kind) return;
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  closeNotif(opts.threadKey);
  try {
    const n = new Notification(withBrandTitle(opts.title), {
      body: opts.body || '',
      icon: opts.icon || brandIcon() || defaultIcon(),
      tag: opts.threadKey,
    });
    notifRefs.set(opts.threadKey, n);
    n.onclick = () => {
      focusAppWindow();
      opts.onClick?.();
      n.close();
    };
  } catch {
    /* ignore */
  }
}

export function formatCommTextTitle(serverName: string, channelName: string, senderName: string) {
  const srv = String(serverName || 'Servidor').trim();
  const ch = String(channelName || 'Canal').trim();
  const who = String(senderName || 'Alguém').trim();
  return `${srv} · ${ch} · ${who}`;
}

export function absIcon(url?: string | null) {
  const s = String(url || '').trim();
  if (!s) return undefined;
  if (/^https?:\/\//i.test(s)) return s;
  try {
    return new URL(s, location.origin).href;
  } catch {
    return undefined;
  }
}

export function requestNotifyPermission() {
  if (typeof Notification === 'undefined') return Promise.resolve('denied' as const);
  if (Notification.permission !== 'default') {
    return Promise.resolve(Notification.permission);
  }
  return Notification.requestPermission().catch(() => 'denied' as NotificationPermission);
}

export function commChannelKey(channelId: number | string) {
  return `comm:ch:${channelId}`;
}

export function commDmKey(userId: number | string, serverId?: number | string | null) {
  return `comm:dm:${userId}:${serverId || 0}`;
}

export function formatDmTitle(senderName: string) {
  return `DM · ${String(senderName || 'Alguém').trim()}`;
}

export function markScreenShareNotified(key: string): boolean {
  if (screenShareNotified.has(key)) return true;
  screenShareNotified.add(key);
  return false;
}

export function resetScreenShareNotified() {
  screenShareNotified.clear();
}

/** Pede permissão uma vez (igual Flask ~4.5s após load). */
export function bootNotifyPermissionPrompt() {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'default') return;
  if (!prefsEnabled()) return;
  window.setTimeout(() => {
    void requestNotifyPermission();
  }, 4500);
}

/** True se o canal/thread aberto deve silenciar (aba visível). */
export function isThreadMuted(threadKey: string): boolean {
  return threadMuted(threadKey);
}
