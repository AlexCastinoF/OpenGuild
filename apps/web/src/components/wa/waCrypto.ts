/** Client-side helpers for WA hub (aligned with ASF community_wa.js). */

import type { WaChat } from './waTypes';

export async function deriveVerifier(pass: string, saltB64: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' },
    base,
    256,
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

export function randomSaltB64(): string {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...saltBytes));
}

export function cryptoRememberKey(sessionId: string) {
  return `sf-wa-crypto-${sessionId}`;
}

export function phoneLabel(meJid?: string, phone?: string, phoneDisplay?: string) {
  if (phoneDisplay) return phoneDisplay;
  const me = (phone || meJid || '').split('@')[0] || '';
  if (!me) return '';
  if (me.startsWith('55') && me.length >= 12) {
    const ddd = me.slice(2, 4);
    const rest = me.slice(4);
    if (rest.length === 9) return `+55 ${ddd} ${rest.slice(0, 5)}-${rest.slice(5)}`;
    if (rest.length === 8) return `+55 ${ddd} ${rest.slice(0, 4)}-${rest.slice(4)}`;
    return `+${me.slice(0, 4)}…${me.slice(-4)}`;
  }
  return me.length > 4 ? `…${me.slice(-4)}` : me;
}

export function formatMePhone(meJid?: string) {
  const digits = (meJid || '').split('@')[0] || '';
  if (!digits) return '';
  if (digits.startsWith('55') && digits.length >= 12) {
    return `+${digits.slice(0, 4)}…${digits.slice(-4)}`;
  }
  return digits.length > 6 ? `…${digits.slice(-4)}` : digits;
}

export function isNoiseChatJid(jid: string) {
  const s = String(jid || '');
  if (!s) return true;
  if (s === 'status@broadcast' || s.includes('status@broadcast')) return true;
  if (s.endsWith('@newsletter') || s.includes('@newsletter')) return true;
  if (s.endsWith('@broadcast')) return true;
  return false;
}

export function chatIsGroup(c: WaChat) {
  return Boolean(c.isGroup || c.kind === 'group' || String(c.jid || '').endsWith('@g.us'));
}

export function chatTitle(c: WaChat) {
  if (!c) return '';
  if (chatIsGroup(c)) {
    const subject = String(c.subject || '').trim();
    if (subject && !subject.includes('@') && subject !== c.jid) return subject;
    const name = String(c.name || '').trim();
    if (name && !name.includes('@') && name !== c.jid) return name;
    return phoneLabel(c.jid) || subject || name || c.jid;
  }
  const contact = String(c.contactName || '').trim();
  if (contact && !contact.includes('@lid') && contact !== c.jid) return contact;
  const name = String(c.name || '').trim();
  if (name && !name.includes('@lid') && name !== c.jid) return name;
  return phoneLabel(c.jid, c.phone, c.phoneDisplay) || name || c.jid;
}

export function chatPushSub(c: WaChat) {
  if (!c || chatIsGroup(c)) return '';
  const push = String(c.pushName || '').trim();
  const title = chatTitle(c);
  if (!push || push === title) return '';
  return push;
}

export function lastMessagePreview(c: WaChat) {
  const lm = c.lastMessage;
  if (!lm) return '';
  if (typeof lm === 'string') return lm;
  const text = String(lm.text || '').trim();
  if (text) return text;
  const t = String(lm.type || '').toLowerCase();
  const labels: Record<string, string> = {
    image: '📷 Foto',
    video: '🎬 Vídeo',
    audio: '🎵 Áudio',
    ptt: '🎤 Áudio',
    sticker: 'Figurinha',
    document: '📄 Documento',
    contact: '👤 Contato',
    contact_array: '👤 Contatos',
    location: '📍 Localização',
    live_location: '📍 Localização ao vivo',
    poll: '📊 Enquete',
    reaction: 'Reação',
    group_invite: 'Convite de grupo',
  };
  return labels[t] || (t ? `[${t}]` : '');
}

export function lastMessageTs(c: WaChat) {
  const lm = c.lastMessage;
  if (lm && typeof lm === 'object') {
    const ms = Number(lm.timestampMs || 0);
    if (ms > 0) return ms;
    const sec = Number(lm.timestampSeconds || 0);
    if (sec > 0) return sec < 1e12 ? sec * 1000 : sec;
  }
  const raw = Number(c.timestampSeconds || c.lastTs || 0);
  if (!raw) return 0;
  return raw < 1e12 ? raw * 1000 : raw;
}

export function formatChatWhen(tsRaw: number) {
  const ts = Number(tsRaw || 0);
  if (!ts) return '';
  const d = new Date(ts < 1e12 ? ts * 1000 : ts);
  const now = new Date();
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYday) return 'Ontem';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export function avatarLetter(label: string, phone = '') {
  const s = String(label || phone || '?').trim();
  return (s[0] || '?').toUpperCase();
}
