/**
 * Gateway HTTP multi-sessão para zapo-js (WhatsApp Web).
 * - Sessão admin "steamfarm": OTP / avisos / Guard (rotas legadas).
 * - Sessões user-{id}-{1|2}: chat completo para o Electron.
 * Só escuta 127.0.0.1.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket as WsWebSocket, WebSocketServer } from "ws";
import QRCode from "qrcode";
import { createPinoLogger, createStore, WaClient, proto, isGroupJid, isStatusBroadcastJid, toUserJid } from "zapo-js";
import { createPostgresStore } from "@zapo-js/store-postgres";
import { createMediaProcessor } from "@zapo-js/media-utils";
import { path as ffmpegPath } from "@ffmpeg-installer/ffmpeg";
import { path as ffprobePath } from "@ffprobe-installer/ffprobe";

if (typeof globalThis.WebSocket !== "function") {
  globalThis.WebSocket = WsWebSocket;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.ZAPO_PORT || 8788);
const INBOUND_URL =
  process.env.ZAPO_INBOUND_URL || "http://127.0.0.1:5000/api/whatsapp/inbound";
const INBOUND_SECRET = process.env.ZAPO_INBOUND_SECRET || "";
const GATEWAY_SECRET = process.env.ZAPO_GATEWAY_SECRET || INBOUND_SECRET || "";
const ADMIN_SESSION = "steamfarm";
const INBOUND_VERSION = 20;
const ZAPO_TABLE_PREFIX = "zapo_";

/** Normaliza URL SQLAlchemy/psycopg para o driver `pg` do Node. */
function normalizePgUrl(raw) {
  let url = String(raw || "").trim();
  if (!url) return "";
  if (url.startsWith("postgresql+psycopg://")) {
    url = "postgresql://" + url.slice("postgresql+psycopg://".length);
  } else if (url.startsWith("postgresql+psycopg2://")) {
    url = "postgresql://" + url.slice("postgresql+psycopg2://".length);
  } else if (url.startsWith("postgres://")) {
    url = "postgresql://" + url.slice("postgres://".length);
  }
  return url;
}

function resolveDatabaseUrl() {
  return normalizePgUrl(
    process.env.ZAPO_DATABASE_URL ||
      process.env.DATABASE_URL ||
      process.env.STEAMFARM_DATABASE_URL ||
      ""
  );
}
const MSG_CACHE_PER_CHAT = 200;
/** sessionId → Map(lidJid → phoneDigits) */
const lidPhoneMaps = new Map();
/** sessionId → Map(jid → { url, ts }) */
const avatarCache = new Map();
/** sessionId → Map(jid → chat stub iniciado no painel) */
const panelChatMaps = new Map();
/** sessionId → { ts, groups, refreshing } */
const groupsCache = new Map();
/** sessionId → { ts, chats, building } */
const chatsCache = new Map();
const CHATS_CACHE_MS = 25_000;
/** sessionId → Map(jid → Set<aliasJid>) */
const jidAliasMaps = new Map();
/** sessionId → Map(authorKey → status feed) */
const statusMaps = new Map();
/** After clear-chats: list only panel stubs (no mailbox/group reseed). */
const panelOnlyLists = new Map();
/** messageId -> { key, message, mimetype } for live media download. */
const mediaPayloadMaps = new Map();
/** sessionId → Set of chat JIDs currently open in the web UI */
const openChatViews = new Map();

/** @type {import('zapo-js').WaStore | null} */
let sharedStore = null;
/** @type {ReturnType<typeof createPostgresStore> | null} */
let pgBackend = null;
/** @type {any} */
let sharedLogger = null;
/** @type {any} */
let mediaProcessor = null;

/** jid → phone (admin alerts) */
const phoneByJid = new Map();
let lastOutboundPhone = "";

/**
 * @typedef {{
 *   client: import('zapo-js').WaClient,
 *   status: string,
 *   qr: string,
 *   qrPng: string,
 *   meJid: string,
 *   pushName: string,
 *   error: string,
 *   connecting: boolean,
 *   reconnectTimer: any,
 *   eventClients: Set<import('http').ServerResponse>,
 *   wsClients: Set<import('ws').WebSocket>,
 *   msgCache: Map<string, object[]>,
 * }} SessionSlot
 */

/** @type {Map<string, SessionSlot>} */
const sessions = new Map();

function json(res, code, body) {
  const raw = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(raw),
  });
  res.end(raw);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const buf = Buffer.concat(chunks);
  const ct = String(req.headers["content-type"] || "");
  if (ct.includes("multipart/form-data")) {
    return parseMultipart(buf, ct);
  }
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return {};
  }
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return {};
  const boundary = m[1] || m[2];
  const parts = buf.toString("binary").split(`--${boundary}`);
  const out = { fields: {}, files: {} };
  for (const part of parts) {
    if (!part || part === "--\r\n" || part === "--") continue;
    const sep = part.indexOf("\r\n\r\n");
    if (sep < 0) continue;
    const head = part.slice(0, sep);
    let body = part.slice(sep + 4);
    if (body.endsWith("\r\n")) body = body.slice(0, -2);
    const nameMatch = /name="([^"]+)"/i.exec(head);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const fileMatch = /filename="([^"]*)"/i.exec(head);
    if (fileMatch) {
      const filename = fileMatch[1] || "upload.bin";
      const mimeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(head);
      const mimetype = (mimeMatch?.[1] || "application/octet-stream").trim();
      const fileBuf = Buffer.from(body, "binary");
      out.files[name] = { filename, mimetype, buffer: fileBuf };
    } else {
      out.fields[name] = Buffer.from(body, "binary").toString("utf8");
    }
  }
  return out;
}

function requireSecret(req) {
  if (!GATEWAY_SECRET) return true;
  const h = req.headers["x-zapo-secret"] || "";
  return h === GATEWAY_SECRET;
}

function unwrapMessage(message, depth = 0) {
  if (!message || depth > 6) return message || null;
  const inner =
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message.documentWithCaptionMessage?.message ||
    message.editedMessage?.message ||
    message.botInvokeMessage?.message ||
    null;
  return inner ? unwrapMessage(inner, depth + 1) : message;
}

function extractText(message) {
  const m = unwrapMessage(message);
  if (!m) return "";
  const base =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.ptvMessage?.caption ||
    "";
  if (base) return base;
  if (m.contactMessage?.displayName) return m.contactMessage.displayName;
  if (m.contactsArrayMessage?.displayName) return m.contactsArrayMessage.displayName;
  if (m.locationMessage?.name) return m.locationMessage.name;
  if (m.liveLocationMessage) return "Localização ao vivo";
  const poll = m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3;
  if (poll?.name) return poll.name;
  if (m.reactionMessage?.text) return m.reactionMessage.text;
  if (m.groupInviteMessage?.groupName) return `Convite: ${m.groupInviteMessage.groupName}`;
  if (m.eventMessage?.name) return m.eventMessage.name;
  return "";
}

function detectMsgType(message) {
  const m = unwrapMessage(message);
  if (!m) return "unknown";
  if (m.conversation || m.extendedTextMessage) return "text";
  if (m.imageMessage || m.albumMessage) return "image";
  if (m.videoMessage || m.ptvMessage) return "video";
  if (m.audioMessage) return m.audioMessage.ptt ? "ptt" : "audio";
  if (m.documentMessage || m.documentWithCaptionMessage) return "document";
  if (m.stickerMessage || m.lottieStickerMessage) return "sticker";
  if (m.locationMessage) return "location";
  if (m.liveLocationMessage) return "live_location";
  if (m.contactMessage) return "contact";
  if (m.contactsArrayMessage) return "contact_array";
  if (m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3) return "poll";
  if (m.pollUpdateMessage) return "poll_update";
  if (m.reactionMessage) return "reaction";
  if (m.buttonsMessage) return "button";
  if (m.listMessage) return "list";
  if (m.interactiveMessage) return "interactive";
  if (m.eventMessage) return "event";
  if (m.orderMessage) return "order";
  if (m.productMessage) return "product";
  if (m.groupInviteMessage) return "group_invite";
  if (m.protocolMessage) {
    const t = m.protocolMessage.type;
    const label = String(t ?? "");
    if (label.includes("REVOKE") || t === 0) return "revoke";
    if (label.includes("EDIT") || t === 14) return "edit";
    return "protocol";
  }
  if (m.senderKeyDistributionMessage) return "skdm";
  if (m.messageContextInfo && Object.keys(m).filter((k) => m[k] != null).length <= 2) {
    // Só metadata / device list — não é bolha
    const keys = Object.keys(m).filter((k) => m[k] != null);
    if (keys.every((k) => k === "messageContextInfo" || k === "senderKeyDistributionMessage")) {
      return "skdm";
    }
  }
  if (m.call) return "call";
  return "other";
}

/** Campos ricos + dump para tipos ainda não mapeados na UI. */
function enrichMessageFields(message) {
  const m = unwrapMessage(message);
  if (!m) return { payloadDebug: "" };
  const out = {};
  if (m.contactMessage) {
    out.contact = {
      displayName: String(m.contactMessage.displayName || "").trim(),
      vcard: String(m.contactMessage.vcard || ""),
    };
  }
  if (m.contactsArrayMessage) {
    out.contactTitle = String(m.contactsArrayMessage.displayName || "").trim();
    out.contacts = (m.contactsArrayMessage.contacts || []).map((c) => ({
      displayName: String(c.displayName || "").trim(),
      vcard: String(c.vcard || ""),
    }));
  }
  const loc = m.locationMessage || m.liveLocationMessage;
  if (loc) {
    out.location = {
      lat: Number(loc.degreesLatitude || 0),
      lng: Number(loc.degreesLongitude || 0),
      name: String(loc.name || "").trim(),
      address: String(loc.address || "").trim(),
      isLive: !!m.liveLocationMessage,
    };
  }
  const poll = m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3;
  if (poll) {
    out.poll = {
      name: String(poll.name || "").trim(),
      options: (poll.options || []).map((o) => String(o.optionName || o.name || "").trim()).filter(Boolean),
    };
  }
  const ext = m.extendedTextMessage;
  if (ext && (ext.title || ext.description || ext.canonicalUrl || ext.matchedText)) {
    out.linkPreview = {
      url: String(ext.canonicalUrl || ext.matchedText || "").trim(),
      title: String(ext.title || "").trim(),
      description: String(ext.description || "").trim(),
    };
  }
  if (m.reactionMessage) {
    out.reaction = {
      text: String(m.reactionMessage.text || ""),
      targetId: String(m.reactionMessage.key?.id || ""),
      targetFromMe: !!m.reactionMessage.key?.fromMe,
      targetParticipant: String(m.reactionMessage.key?.participant || ""),
      targetRemoteJid: String(m.reactionMessage.key?.remoteJid || ""),
    };
  }
  if (m.groupInviteMessage) {
    out.groupInvite = {
      groupName: String(m.groupInviteMessage.groupName || ""),
      inviteCode: String(m.groupInviteMessage.inviteCode || ""),
    };
  }
  if (m.eventMessage) {
    out.event = {
      name: String(m.eventMessage.name || ""),
      description: String(m.eventMessage.description || ""),
      startTime: Number(m.eventMessage.startTime || 0),
    };
  }
  const type = detectMsgType(message);
  const known = new Set([
    "text",
    "image",
    "video",
    "audio",
    "ptt",
    "document",
    "sticker",
    "location",
    "live_location",
    "contact",
    "contact_array",
    "poll",
    "reaction",
  ]);
  if (!known.has(type) || type === "other" || type === "unknown") {
    try {
      const keys = Object.keys(m).filter((k) => m[k] != null);
      let snippet = JSON.stringify(
        m,
        (_k, val) => {
          if (val == null) return undefined;
          if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(val)) return `<bytes:${val.length}>`;
          if (val instanceof Uint8Array) return `<bytes:${val.length}>`;
          if (typeof val === "string" && val.length > 240) return `${val.slice(0, 240)}…`;
          return val;
        },
        2
      );
      if (snippet.length > 3500) snippet = `${snippet.slice(0, 3500)}\n…`;
      out.payloadDebug = `type=${type}\nkeys=${keys.join(",")}\n${snippet}`;
    } catch (err) {
      out.payloadDebug = `type=${type}\n(error serializing: ${err?.message || err})`;
    }
  }
  return out;
}

function mediaFieldsFromMessage(message) {
  const m = unwrapMessage(message);
  if (!m) return { mimetype: "", fileName: "" };
  return {
    mimetype:
      m.imageMessage?.mimetype ||
      m.videoMessage?.mimetype ||
      m.ptvMessage?.mimetype ||
      m.audioMessage?.mimetype ||
      m.documentMessage?.mimetype ||
      m.stickerMessage?.mimetype ||
      m.lottieStickerMessage?.mimetype ||
      "",
    fileName: m.documentMessage?.fileName || "",
  };
}

function phoneFromJid(jid) {
  const raw = String(jid || "");
  if (raw.includes("@lid")) return "";
  // Strip device suffix (:78) before digits — else 5511…:78 → …778
  const user = (raw.split("@")[0] || "").split(":")[0];
  if (!raw.includes("@s.whatsapp.net") && !/^\d+$/.test(user)) return "";
  return user.replace(/\D/g, "");
}

/** Credenciais costumam vir com device (`user:12@s.whatsapp.net`) — APIs de perfil pedem o user JID. */
function normalizeUserJid(jid) {
  const raw = String(jid || "").trim();
  if (!raw) return "";
  try {
    const n = toUserJid(raw);
    if (n) return String(n);
  } catch {
    /* ignore */
  }
  if (raw.includes("@")) {
    const [userPart, server] = raw.split("@");
    const user = (userPart || "").split(":")[0];
    if (user && server) return `${user}@${server}`;
  }
  return raw;
}

function ownJidCandidates(sessionId, meJid) {
  const raw = String(meJid || "").trim();
  const user = normalizeUserJid(raw);
  const phone = phoneFromJid(user) || phoneFromJid(raw);
  const pn = phone ? `${phone}@s.whatsapp.net` : "";
  const out = [];
  const seen = new Set();
  for (const j of [user, raw, pn, ...expandChatJids(sessionId, user || raw)]) {
    const s = String(j || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

async function syncSlotIdentity(slot) {
  if (!slot?.client) return slot;
  let creds = null;
  try {
    creds = slot.client.getCredentials?.() || null;
  } catch {
    creds = null;
  }
  if (!creds) {
    try {
      creds = slot.client.auth?.getCurrentCredentials?.() || null;
    } catch {
      creds = null;
    }
  }
  const rawMe = creds?.meJid || slot.meJid || "";
  const meJid = normalizeUserJid(rawMe) || rawMe;
  if (meJid) slot.meJid = meJid;
  const push = String(
    creds?.pushName || creds?.meDisplayName || slot.pushName || ""
  ).trim();
  if (push) slot.pushName = push;
  return slot;
}

async function fetchOwnAvatarBytes(slot, sessionId, candidates, { force = false } = {}) {
  let cache = avatarCache.get(sessionId);
  if (!cache) {
    cache = new Map();
    avatarCache.set(sessionId, cache);
  }
  if (force) {
    for (const j of candidates) cache.delete(j);
  }
  if (!force) {
    for (const j of candidates) {
      const hit = cache.get(j);
      if (hit?.buf && Date.now() - hit.ts < 10 * 60_000) {
        return { buf: hit.buf, ctype: hit.ctype || "image/jpeg", pictureId: hit.id || "", fromCache: true };
      }
    }
  }
  for (const j of candidates) {
    for (const typ of ["preview", "image"]) {
      try {
        const pic = await slot.client.profile.getProfilePicture(j, typ);
        const url = String(pic?.url || "").trim();
        if (!url) continue;
        const remote = await fetch(url);
        if (!remote.ok) continue;
        const buf = Buffer.from(await remote.arrayBuffer());
        const ctype = remote.headers.get("content-type") || "image/jpeg";
        const pictureId = String(pic?.id || "");
        for (const key of candidates) {
          cache.set(key, { ts: Date.now(), buf, ctype, id: pictureId });
        }
        return { buf, ctype, pictureId, fromCache: false };
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

async function resolveOwnProfile(sessionId, { force = false } = {}) {
  const slot = await ensureConnected(sessionId);
  await syncSlotIdentity(slot);
  const meJid = String(slot.meJid || "").trim();
  const candidates = ownJidCandidates(sessionId, meJid);
  const phone = phoneFromJid(meJid) || candidates.map(phoneFromJid).find(Boolean) || "";

  let about = "";
  for (const j of candidates) {
    try {
      const aboutMex = await slot.client.profile.getAboutStatus(j);
      if (aboutMex != null && String(aboutMex).trim()) {
        about = String(aboutMex).trim();
        break;
      }
    } catch {
      /* ignore */
    }
  }
  if (!about) {
    for (const j of candidates) {
      try {
        const st = await slot.client.profile.getStatus(j);
        about = typeof st === "string" ? st : String(st?.status || st?.text || "");
        if (about.trim()) {
          about = about.trim();
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }

  let username = "";
  try {
    const own = await slot.client.profile.getOwnUsername();
    username = String(own?.username || own?.value || own?.name || "").trim();
  } catch {
    username = "";
  }

  if (!slot.pushName) {
    // Credenciais: pushName costuma vir vazio; o nome do aparelho fica em meDisplayName.
    try {
      const creds = slot.client.getCredentials?.() || null;
      const fromCreds = String(creds?.pushName || creds?.meDisplayName || "").trim();
      if (fromCreds) slot.pushName = fromCreds;
    } catch {
      /* ignore */
    }
  }
  if (!slot.pushName && pgBackend?.pool) {
    try {
      const { rows } = await pgBackend.pool.query(
        `SELECT push_name, me_display_name FROM "${ZAPO_TABLE_PREFIX}auth_credentials" WHERE session_id = $1 LIMIT 1`,
        [sessionId]
      );
      const row = rows?.[0];
      const fromDb = String(row?.push_name || row?.me_display_name || "").trim();
      if (fromDb) slot.pushName = fromDb;
    } catch {
      /* ignore */
    }
  }
  if (!slot.pushName && candidates.length) {
    try {
      const profiles = await slot.client.profile.getProfiles(candidates.slice(0, 4));
      const first = Array.isArray(profiles) ? profiles.find(Boolean) : null;
      const statusText = first?.status || first?.about || "";
      if (!about && statusText) about = String(statusText).trim();
      const n = String(first?.name || first?.pushName || first?.notify || "").trim();
      if (n) slot.pushName = n;
    } catch {
      /* ignore */
    }
  }
  if (!slot.pushName && username) slot.pushName = username;

  let privacy = null;
  try {
    privacy = await slot.client.privacy.getPrivacySettings();
  } catch {
    privacy = null;
  }

  const av = await fetchOwnAvatarBytes(slot, sessionId, candidates, { force });
  const avatarDataUrl = av?.buf
    ? `data:${av.ctype || "image/jpeg"};base64,${av.buf.toString("base64")}`
    : "";
  const avatarJid = normalizeUserJid(meJid) || candidates[0] || "";

  return {
    ok: true,
    pushName: slot.pushName || "",
    username,
    meJid: avatarJid,
    phoneDisplay: formatPhoneDisplay(phone),
    about: String(about || "").trim(),
    privacy,
    hasAvatar: !!av?.buf,
    pictureId: av?.pictureId || "",
    avatarUrl: avatarJid
      ? `avatar?jid=${encodeURIComponent(avatarJid)}&t=${Date.now()}`
      : "",
    avatarDataUrl,
  };
}

function rememberPhone(jid, phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!jid || digits.length < 10) return;
  phoneByJid.set(String(jid), digits);
  lastOutboundPhone = digits;
}

function lidMapFor(sessionId) {
  let m = lidPhoneMaps.get(sessionId);
  if (!m) {
    m = new Map();
    lidPhoneMaps.set(sessionId, m);
  }
  return m;
}

function rememberLidPhone(sessionId, eventOrJid, phoneMaybe) {
  if (eventOrJid && typeof eventOrJid === "object") {
    const event = eventOrJid;
    const remote = String(event.key?.remoteJid || "");
    const alt = String(event.key?.remoteJidAlt || "");
    const part = String(event.key?.participant || "");
    const partAlt = String(event.key?.participantAlt || "");
    const pairs = [
      [remote, alt],
      [alt, remote],
      [part, partAlt],
      [partAlt, part],
    ];
    const map = lidMapFor(sessionId);
    for (const [a, b] of pairs) {
      const phone = phoneFromJid(a) || phoneFromJid(b);
      if (!phone || phone.length < 10) continue;
      if (String(a).includes("@lid")) map.set(String(a), phone);
      if (String(b).includes("@lid")) map.set(String(b), phone);
      rememberPhone(a, phone);
      rememberPhone(b, phone);
      if (a && b) linkJidAliases(sessionId, a, b);
      if (phone) {
        linkJidAliases(sessionId, a, `${phone}@s.whatsapp.net`);
        linkJidAliases(sessionId, b, `${phone}@s.whatsapp.net`);
      }
    }
    return;
  }
  const jid = String(eventOrJid || "");
  const digits = String(phoneMaybe || "").replace(/\D/g, "");
  if (!jid || digits.length < 10) return;
  if (jid.includes("@lid")) lidMapFor(sessionId).set(jid, digits);
  rememberPhone(jid, digits);
  linkJidAliases(sessionId, jid, `${digits}@s.whatsapp.net`);
}

function formatPhoneDisplay(digits) {
  const d = String(digits || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4);
    const rest = d.slice(4);
    if (rest.length === 9) return `+55 ${ddd} ${rest.slice(0, 5)}-${rest.slice(5)}`;
    if (rest.length === 8) return `+55 ${ddd} ${rest.slice(0, 4)}-${rest.slice(4)}`;
  }
  return d.length > 8 ? `+${d}` : d;
}

function resolveJidPhone(sessionId, jid, contact) {
  const raw = String(jid || "");
  const fromJid = phoneFromJid(raw);
  if (fromJid.length >= 10) return fromJid;
  const fromContact = String(contact?.phoneNumber || "").replace(/\D/g, "");
  if (fromContact.length >= 10) {
    rememberLidPhone(sessionId, raw, fromContact);
    return fromContact;
  }
  const mapped = lidMapFor(sessionId).get(raw) || phoneByJid.get(raw) || "";
  if (mapped.length >= 10) return mapped;
  return "";
}

function resolvePhone(event) {
  const remote = String(event.key?.remoteJid || "");
  const alt = String(event.key?.remoteJidAlt || "");
  const fromPn =
    phoneFromJid(alt) ||
    phoneFromJid(event.key?.participantAlt) ||
    (remote.includes("@s.whatsapp.net") ? phoneFromJid(remote) : "");
  if (fromPn.length >= 10) {
    rememberPhone(remote, fromPn);
    if (alt) rememberPhone(alt, fromPn);
    return fromPn;
  }
  const mapped = phoneByJid.get(remote) || (alt ? phoneByJid.get(alt) : "") || "";
  if (mapped.length >= 10) return mapped;
  if (lastOutboundPhone.length >= 10) return lastOutboundPhone;
  return "";
}

function isStatusJid(jid) {
  const s = String(jid || "");
  if (!s) return false;
  if (typeof isStatusBroadcastJid === "function" && isStatusBroadcastJid(s)) return true;
  if (s === "status@broadcast") return true;
  if (s.endsWith("@broadcast") && s.includes("status")) return true;
  return false;
}

function isNoiseJid(jid) {
  const s = String(jid || "");
  if (!s) return true;
  if (isStatusJid(s)) return true;
  if (s.endsWith("@newsletter") || s.includes("@newsletter")) return true;
  if (s.endsWith("@broadcast")) return true;
  if (s === "0@s.whatsapp.net") return true;
  return false;
}

function statusMapFor(sessionId) {
  let m = statusMaps.get(sessionId);
  if (!m) {
    m = new Map();
    statusMaps.set(sessionId, m);
  }
  return m;
}

function mediaMapFor(sessionId) {
  let m = mediaPayloadMaps.get(sessionId);
  if (!m) {
    m = new Map();
    mediaPayloadMaps.set(sessionId, m);
  }
  return m;
}

function rememberMediaPayload(sessionId, event, serialized) {
  if (!serialized?.hasMedia || !serialized.id || !event?.message) return;
  mediaMapFor(sessionId).set(serialized.id, {
    key: {
      remoteJid: event.key?.remoteJid || serialized.chatJid,
      remoteJidAlt: event.key?.remoteJidAlt || serialized.chatJidAlt,
      id: event.key?.id || serialized.id,
      fromMe: !!event.key?.fromMe,
      participant: event.key?.participant || serialized.participant || undefined,
    },
    message: event.message,
    mimetype: serialized.mimetype || "application/octet-stream",
  });
  if (mediaMapFor(sessionId).size > 400) {
    const first = mediaMapFor(sessionId).keys().next().value;
    mediaMapFor(sessionId).delete(first);
  }
}

function preferChatJid(sessionId, jid, alt) {
  const a = String(jid || "");
  const b = String(alt || "");
  if (a && !a.includes("@lid")) return a;
  if (b && !b.includes("@lid")) return b;
  const phone = resolveJidPhone(sessionId, a, null) || resolveJidPhone(sessionId, b, null);
  if (phone.length >= 10) return `${phone}@s.whatsapp.net`;
  return a || b;
}

function canonicalChatKey(sessionId, jid, phoneHint = "") {
  const j = String(jid || "");
  if (!j) return "";
  if (isGroupJid(j)) return `g:${j}`;
  const phone =
    String(phoneHint || "").replace(/\D/g, "") ||
    resolveJidPhone(sessionId, j, null) ||
    phoneFromJid(j);
  if (phone.length >= 10) return `pn:${phone}`;
  const aliases = expandChatJids(sessionId, j);
  for (const a of aliases) {
    const p = phoneFromJid(a) || lidMapFor(sessionId).get(a) || "";
    if (String(p).replace(/\D/g, "").length >= 10) return `pn:${String(p).replace(/\D/g, "")}`;
  }
  return `j:${j}`;
}

function rememberStatusItem(sessionId, serialized, extra = {}) {
  const fromMe = !!serialized.fromMe;
  const authorJid = fromMe
    ? "me"
    : serialized.participant || serialized.chatJidAlt || "";
  if (!fromMe && (!authorJid || isNoiseJid(authorJid))) return null;
  const key = fromMe ? "me" : authorJid;
  const map = statusMapFor(sessionId);
  let feed = map.get(key);
  if (!feed) {
    const phone = fromMe ? "" : resolveJidPhone(sessionId, authorJid, null);
    feed = {
      authorKey: key,
      authorJid: key,
      pushName: serialized.pushName || (fromMe ? "Meu status" : ""),
      phone,
      phoneDisplay: formatPhoneDisplay(phone),
      items: [],
    };
    map.set(key, feed);
  }
  if (serialized.pushName && !fromMe) feed.pushName = serialized.pushName;
  const item = {
    id: serialized.id,
    text: serialized.text || "",
    type: serialized.type || "text",
    hasMedia: !!serialized.hasMedia,
    mimetype: serialized.mimetype || "",
    timestampSeconds: serialized.timestampSeconds || Math.floor(Date.now() / 1000),
    fromMe,
    recipients: Number(extra.recipients || 0),
    views: Number(extra.views || 0),
    viewers: Array.isArray(extra.viewers) ? extra.viewers : [],
  };
  const idx = feed.items.findIndex((x) => x.id === item.id);
  if (idx >= 0) feed.items[idx] = { ...feed.items[idx], ...item };
  else feed.items.push(item);
  feed.items.sort((a, b) => (a.timestampSeconds || 0) - (b.timestampSeconds || 0));
  if (feed.items.length > 40) feed.items.splice(0, feed.items.length - 40);
  return feed;
}

function listStatusesPublic(sessionId) {
  const feeds = [...statusMapFor(sessionId).values()].map((f) => ({
    authorKey: f.authorKey,
    authorJid: f.authorJid,
    pushName: f.pushName || (f.authorKey === "me" ? "Meu status" : f.phoneDisplay || f.authorJid),
    phone: f.phone || "",
    phoneDisplay: f.phoneDisplay || "",
    isMe: f.authorKey === "me",
    items: [...(f.items || [])].slice().reverse(),
    lastAt: f.items?.[f.items.length - 1]?.timestampSeconds || 0,
  }));
  feeds.sort((a, b) => {
    if (a.isMe) return -1;
    if (b.isMe) return 1;
    return (b.lastAt || 0) - (a.lastAt || 0);
  });
  return feeds;
}

function applyReceiptToCache(slot, sessionId, event) {
  const ids = new Set(
    [...(event.messageIds || []), event.stanzaId || event.id || ""].filter(Boolean)
  );
  if (!ids.size) return [];
  const status = String(event.status || "").toLowerCase();
  const rank = { sent: 1, server: 1, delivered: 2, read: 3, played: 3 };
  const next = status === "played" ? "read" : status === "server" ? "sent" : status;
  if (!rank[next]) return [];
  const updated = [];
  const seenMsg = new Set();
  for (const arr of slot.msgCache.values()) {
    for (const m of arr) {
      if (!ids.has(m.id) || !m.fromMe) continue;
      const cur = rank[m.ackStatus || ""] || 0;
      if (rank[next] > cur) {
        m.ackStatus = next;
        if (!seenMsg.has(m.id)) {
          seenMsg.add(m.id);
          updated.push({
            id: m.id,
            chatJid: m.chatJid,
            chatJidAlt: m.chatJidAlt || "",
            ackStatus: next,
          });
        }
      }
    }
  }
  const chat = String(event.chatJid || "");
  if (isNoiseJid(chat) || chat === "status@broadcast") {
    const viewer = String(event.participant || event.participantAlt || "");
    for (const feed of statusMapFor(sessionId).values()) {
      for (const item of feed.items) {
        if (!ids.has(item.id)) continue;
        if (!item.viewers) item.viewers = [];
        if (viewer && !item.viewers.some((v) => v.jid === viewer)) {
          item.viewers.push({ jid: viewer, at: Date.now() });
          item.views = item.viewers.length;
          updated.push({ id: item.id, statusView: true, views: item.views, authorKey: feed.authorKey });
        }
      }
    }
  }
  return updated;
}

async function listContacts(sessionId) {
  await ensureShared();
  if (!pgBackend?.pool) return [];
  try {
    const table = `"${ZAPO_TABLE_PREFIX}mailbox_contacts"`;
    const { rows } = await pgBackend.pool.query(
      `SELECT jid, display_name, push_name, lid, phone_number
       FROM ${table} WHERE session_id = $1
       ORDER BY display_name, push_name, jid`,
      [sessionId]
    );
    const byPhone = new Map();
    const orphan = [];
    for (const r of rows) {
      const phone = String(r.phone_number || "").replace(/\D/g, "");
      const item = {
        jid: r.jid,
        name: r.display_name || r.push_name || "",
        displayName: r.display_name || "",
        pushName: r.push_name || "",
        lid: r.lid || (String(r.jid || "").includes("@lid") ? r.jid : ""),
        phone,
        phoneDisplay: formatPhoneDisplay(r.phone_number),
      };
      if (phone.length >= 10) {
        const prev = byPhone.get(phone);
        if (!prev || (!prev.name && item.name) || (prev.jid.includes("@lid") && !item.jid.includes("@lid"))) {
          byPhone.set(phone, item);
        }
      } else {
        orphan.push(item);
      }
    }
    return [...byPhone.values(), ...orphan].sort((a, b) =>
      String(a.name || a.phoneDisplay || a.jid).localeCompare(
        String(b.name || b.phoneDisplay || b.jid),
        "pt-BR"
      )
    );
  } catch (err) {
    console.warn("listContacts", err?.message || err);
    return [];
  }
}

function messageTimeMs(m) {
  if (!m) return 0;
  const ms = Number(m.timestampMs || 0);
  if (ms > 0) return ms;
  const sec = Number(m.timestampSeconds || m.ts || m.timestamp || 0);
  if (!sec) return 0;
  return sec < 1e12 ? sec * 1000 : sec;
}

function compareMessagesAsc(a, b) {
  const d = messageTimeMs(a) - messageTimeMs(b);
  if (d !== 0) return d;
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function serializeMessage(event) {
  const message = event.message || null;
  const type = detectMsgType(message);
  const media = mediaFieldsFromMessage(message);
  const rich = enrichMessageFields(message);
  const chatJid = event.key?.remoteJid || "";
  const chatJidAlt = event.key?.remoteJidAlt || "";
  const fromMe = !!event.key?.fromMe;
  const senderDevice = Number(event.key?.senderDevice ?? -1);
  // Device 0 = aparelho principal (celular). Companion web/desktop usa id > 0.
  const fromPhone = fromMe && senderDevice === 0;
  const isGroup = !!event.key?.isGroup || isGroupJid(chatJid);
  const text = extractText(message);
  const timestampSeconds = event.timestampSeconds || Math.floor(Date.now() / 1000);
  // WA só entrega segundos; ms real só em outbound local (Date.now)
  const timestampMs =
    Number(event.timestampMs || 0) ||
    (event.timestampSeconds ? Number(event.timestampSeconds) * 1000 : Date.now());
  return {
    id: event.key?.id || "",
    chatJid,
    chatJidAlt,
    fromMe,
    senderDevice: Number.isFinite(senderDevice) ? senderDevice : -1,
    fromPhone,
    participant: event.key?.participant || "",
    participantAlt: event.key?.participantAlt || "",
    isGroup,
    pushName: event.pushName || "",
    timestampSeconds,
    timestampMs,
    type,
    text,
    ackStatus: fromMe ? "sent" : "",
    isStatus: isStatusJid(chatJid),
    hasMedia: ["image", "video", "audio", "ptt", "document", "sticker"].includes(type),
    mimetype: media.mimetype,
    fileName: media.fileName,
    ...rich,
    rawKey: {
      remoteJid: event.key?.remoteJid,
      remoteJidAlt: event.key?.remoteJidAlt,
      id: event.key?.id,
      fromMe: event.key?.fromMe,
      participant: event.key?.participant,
      participantAlt: event.key?.participantAlt,
      senderDevice: event.key?.senderDevice,
    },
  };
}

function decodeStoredMessage(record) {
  let message = null;
  if (record.messageBytes?.length) {
    try {
      message = proto.Message.decode(record.messageBytes);
    } catch {
      message = null;
    }
  }
  const type = detectMsgType(message);
  const media = mediaFieldsFromMessage(message);
  const rich = enrichMessageFields(message);
  const timestampMs = record.timestampMs ? Number(record.timestampMs) : 0;
  return {
    id: record.id,
    chatJid: record.threadJid,
    fromMe: !!record.fromMe,
    fromPhone: false,
    participant: record.participantJid || record.senderJid || "",
    participantAlt: "",
    isGroup: isGroupJid(record.threadJid || ""),
    pushName: "",
    timestampSeconds: timestampMs ? Math.floor(timestampMs / 1000) : 0,
    timestampMs,
    type,
    text: extractText(message),
    hasMedia: ["image", "video", "audio", "ptt", "document", "sticker"].includes(type),
    mimetype: media.mimetype,
    fileName: media.fileName,
    ...rich,
    rawKey: {
      remoteJid: record.threadJid,
      id: record.id,
      fromMe: !!record.fromMe,
      participant: record.participantJid || undefined,
    },
    _message: message,
  };
}

function broadcast(slot, eventName, payload) {
  const data = JSON.stringify({ event: eventName, data: payload, ts: Date.now() });
  for (const res of slot.eventClients) {
    try {
      res.write(`data: ${data}\n\n`);
    } catch {
      slot.eventClients.delete(res);
    }
  }
  for (const ws of slot.wsClients) {
    if (ws.readyState === 1) {
      try {
        ws.send(data);
      } catch {
        slot.wsClients.delete(ws);
      }
    }
  }
}

/** Keep SSE proxies / load balancers from idling out. */
setInterval(() => {
  for (const slot of sessions.values()) {
    for (const res of slot.eventClients) {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        slot.eventClients.delete(res);
      }
    }
  }
}, 15000);

let aliasTableReady = false;
let messageIndexTableReady = false;

async function ensureAliasTable() {
  if (aliasTableReady || !pgBackend?.pool) return;
  const table = `"${ZAPO_TABLE_PREFIX}jid_aliases"`;
  await pgBackend.pool.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      session_id TEXT NOT NULL,
      jid_a TEXT NOT NULL,
      jid_b TEXT NOT NULL,
      PRIMARY KEY (session_id, jid_a, jid_b)
    );
    CREATE INDEX IF NOT EXISTS "${ZAPO_TABLE_PREFIX}jid_aliases_session_b_idx"
      ON ${table} (session_id, jid_b);
  `);
  aliasTableReady = true;
}

async function ensureMessageIndexTable() {
  if (messageIndexTableReady || !pgBackend?.pool) return;
  const table = `"${ZAPO_TABLE_PREFIX}message_threads"`;
  await pgBackend.pool.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      thread_jid TEXT NOT NULL,
      PRIMARY KEY (session_id, message_id, thread_jid)
    );
    CREATE INDEX IF NOT EXISTS "${ZAPO_TABLE_PREFIX}message_threads_lookup_idx"
      ON ${table} (session_id, thread_jid, message_id);
  `);
  messageIndexTableReady = true;
}

async function persistMessageThreadIndex(sessionId, messageId, threadJids) {
  if (!messageId || !pgBackend?.pool) return;
  const list = [...new Set([...threadJids].filter(Boolean))];
  if (!list.length) return;
  try {
    await ensureMessageIndexTable();
    const table = `"${ZAPO_TABLE_PREFIX}message_threads"`;
    for (const tj of list) {
      await pgBackend.pool.query(
        `INSERT INTO ${table} (session_id, message_id, thread_jid) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [sessionId, messageId, tj]
      );
    }
  } catch (err) {
    console.warn("persistMessageThreadIndex", err?.message || err);
  }
}

async function persistJidAliasPairToDb(sessionId, a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (!left || !right || left === right || !pgBackend?.pool) return;
  try {
    await ensureAliasTable();
    const table = `"${ZAPO_TABLE_PREFIX}jid_aliases"`;
    await pgBackend.pool.query(
      `INSERT INTO ${table} (session_id, jid_a, jid_b) VALUES ($1, $2, $3), ($1, $3, $2)
       ON CONFLICT DO NOTHING`,
      [sessionId, left, right]
    );
  } catch (err) {
    console.warn("persistJidAliasPairToDb", err?.message || err);
  }
}

function linkJidAliasesMemory(sessionId, a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (!left || !right || left === right) return;
  let map = jidAliasMaps.get(sessionId);
  if (!map) {
    map = new Map();
    jidAliasMaps.set(sessionId, map);
  }
  for (const [x, y] of [
    [left, right],
    [right, left],
  ]) {
    let set = map.get(x);
    if (!set) {
      set = new Set();
      map.set(x, set);
    }
    set.add(y);
  }
}

function linkJidAliases(sessionId, a, b) {
  linkJidAliasesMemory(sessionId, a, b);
  void persistJidAliasPairToDb(sessionId, a, b);
}

function expandChatJids(sessionId, jid) {
  const root = String(jid || "");
  const out = new Set();
  if (!root) return out;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || out.has(cur)) continue;
    out.add(cur);
    const aliases = jidAliasMaps.get(sessionId)?.get(cur);
    if (aliases) for (const a of aliases) stack.push(a);
    const phone = lidMapFor(sessionId).get(cur) || phoneByJid.get(cur) || "";
    if (phone.length >= 10) {
      stack.push(`${phone}@s.whatsapp.net`);
    }
    const digits = phoneFromJid(cur);
    if (digits.length >= 10) {
      for (const [lid, pn] of lidMapFor(sessionId)) {
        if (pn === digits) stack.push(lid);
      }
    }
  }
  return out;
}

/** sessionId → last hydrate ts */
const identityHydratedAt = new Map();

function applyContactIdentity(sessionId, c) {
  const phone = String(c?.phone || c?.phoneNumber || "").replace(/\D/g, "");
  const jid = String(c?.jid || "");
  const lid = String(c?.lid || "");
  if (phone.length >= 10) {
    if (jid) rememberLidPhone(sessionId, jid, phone);
    if (lid) rememberLidPhone(sessionId, lid, phone);
    const pnJid = `${phone}@s.whatsapp.net`;
    if (jid) linkJidAliases(sessionId, jid, pnJid);
    if (lid) linkJidAliases(sessionId, lid, pnJid);
  }
  if (jid && lid) linkJidAliases(sessionId, jid, lid);
}

async function hydrateSessionIdentityMaps(sessionId, { force = false } = {}) {
  const last = identityHydratedAt.get(sessionId) || 0;
  if (!force && Date.now() - last < 15_000) return;
  identityHydratedAt.set(sessionId, Date.now());
  try {
    await ensureShared();
    const contacts = await listContacts(sessionId);
    for (const c of contacts || []) applyContactIdentity(sessionId, c);
    // Also link thread JIDs ↔ phone via contact rows (covers LID chats after restart)
    if (pgBackend?.pool) {
      const table = `"${ZAPO_TABLE_PREFIX}mailbox_contacts"`;
      const { rows } = await pgBackend.pool.query(
        `SELECT jid, lid, phone_number FROM ${table} WHERE session_id = $1`,
        [sessionId]
      );
      for (const r of rows || []) {
        applyContactIdentity(sessionId, {
          jid: r.jid,
          lid: r.lid,
          phone: r.phone_number,
        });
      }
      await ensureAliasTable();
      const aliasTable = `"${ZAPO_TABLE_PREFIX}jid_aliases"`;
      const aliasRows = await pgBackend.pool.query(
        `SELECT jid_a, jid_b FROM ${aliasTable} WHERE session_id = $1`,
        [sessionId]
      );
      for (const r of aliasRows.rows || []) {
        linkJidAliasesMemory(sessionId, r.jid_a, r.jid_b);
      }
    }
  } catch (err) {
    console.warn("hydrateSessionIdentityMaps", err?.message || err);
  }
}

/** Resolve contact by jid / lid / phone aliases (survives LID↔PN mismatch). */
async function lookupContact(sessionId, jid) {
  await ensureShared();
  const bundle = sharedStore.session(sessionId);
  const tried = new Set();
  const queue = [...expandChatJids(sessionId, jid), String(jid || "")].filter(Boolean);
  for (const key of queue) {
    if (!key || tried.has(key)) continue;
    tried.add(key);
    try {
      const hit = await bundle.contacts.getByJid(key);
      if (hit) {
        applyContactIdentity(sessionId, {
          jid: hit.jid,
          lid: hit.lid,
          phone: hit.phoneNumber,
        });
        return hit;
      }
    } catch {
      /* ignore */
    }
  }
  if (!pgBackend?.pool) return null;
  try {
    const table = `"${ZAPO_TABLE_PREFIX}mailbox_contacts"`;
    const phone =
      resolveJidPhone(sessionId, jid, null) ||
      phoneFromJid(jid) ||
      "";
    const { rows } = await pgBackend.pool.query(
      `SELECT jid, display_name, push_name, lid, phone_number, username, last_updated_ms
       FROM ${table}
       WHERE session_id = $1 AND (
         jid = $2 OR lid = $2 OR phone_number = $3
         OR ($3 <> '' AND phone_number = $3)
       )
       LIMIT 1`,
      [sessionId, String(jid || ""), phone]
    );
    const row = rows?.[0];
    if (!row) return null;
    const hit = {
      jid: row.jid,
      displayName: row.display_name || undefined,
      pushName: row.push_name || undefined,
      lid: row.lid || undefined,
      phoneNumber: row.phone_number || undefined,
      username: row.username || undefined,
      lastUpdatedMs: Number(row.last_updated_ms || Date.now()),
    };
    applyContactIdentity(sessionId, { jid: hit.jid, lid: hit.lid, phone: hit.phoneNumber });
    return hit;
  } catch (err) {
    console.warn("lookupContact", err?.message || err);
    return null;
  }
}

async function resolveSenderDisplayName(sessionId, participant, participantAlt = "", pushNameFallback = "") {
  const fallback = String(pushNameFallback || "").trim();
  const jids = [...new Set([participant, participantAlt].filter(Boolean))];
  for (const j of jids) {
    const contact = await lookupContact(sessionId, j);
    const name = String(contact?.displayName || contact?.pushName || "").trim();
    if (name && name !== j && !name.includes("@")) return name;
  }
  for (const j of jids) {
    const phone = resolveJidPhone(sessionId, j, null) || phoneFromJid(j);
    if (phone.length >= 10) return formatPhoneDisplay(phone);
  }
  return fallback;
}

async function enrichGroupMessageSenders(sessionId, messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || m.fromMe || !(m.isGroup || isGroupJid(m.chatJid || ""))) {
      out.push(m);
      continue;
    }
    if (String(m.pushName || "").trim()) {
      out.push(m);
      continue;
    }
    const pushName = await resolveSenderDisplayName(
      sessionId,
      m.participant,
      m.participantAlt,
      ""
    );
    out.push(pushName ? { ...m, pushName } : m);
  }
  return out;
}

async function rememberContactPushName(sessionId, jid, pushName, phone = "") {
  const name = String(pushName || "").trim();
  if (!name || !jid || isNoiseJid(jid) || isGroupJid(jid)) return;
  try {
    await ensureShared();
    const bundle = sharedStore.session(sessionId);
    const digits = String(phone || "").replace(/\D/g, "") || resolveJidPhone(sessionId, jid, null);
    await bundle.contacts.upsert({
      jid,
      pushName: name,
      phoneNumber: digits.length >= 10 ? digits : undefined,
      lid: String(jid).includes("@lid") ? jid : undefined,
      lastUpdatedMs: Date.now(),
    });
    applyContactIdentity(sessionId, { jid, lid: String(jid).includes("@lid") ? jid : "", phone: digits });
  } catch (err) {
    console.warn("rememberContactPushName", err?.message || err);
  }
}

function encodeOutboundMessageBytes(text, type = "text") {
  const body = String(text || "");
  try {
    if (type === "text" || type === "extendedText" || !type) {
      return proto.Message.encode(
        proto.Message.create({
          extendedTextMessage: { text: body || " " },
        })
      ).finish();
    }
    // Stub so fromMe media/docs still appear after restart (download may need live cache)
    const label =
      type === "image"
        ? "📷 Imagem"
        : type === "video"
          ? "🎬 Vídeo"
          : type === "audio"
            ? "🎵 Áudio"
            : type === "sticker"
              ? "Figurinha"
              : type === "document"
                ? "📄 Documento"
                : body || `[${type}]`;
    return proto.Message.encode(
      proto.Message.create({
        extendedTextMessage: { text: body || label },
      })
    ).finish();
  } catch {
    return null;
  }
}

/** Bytes proto de reactionMessage para reidratar chips após restart. */
function encodeOutboundReactionBytes(emoji, target = {}) {
  try {
    return proto.Message.encode(
      proto.Message.create({
        reactionMessage: {
          text: String(emoji || ""),
          key: {
            remoteJid: String(target.remoteJid || target.targetRemoteJid || "") || undefined,
            id: String(target.id || target.targetId || ""),
            fromMe: !!target.fromMe || !!target.targetFromMe,
            participant: target.participant || target.targetParticipant || undefined,
          },
        },
      })
    ).finish();
  } catch {
    return null;
  }
}

function encodeOutboundMessageBytesFromContent(content, text, type) {
  if (typeof content === "string") return encodeOutboundMessageBytes(text, "text");
  const mediaPath = content?.media;
  if (!mediaPath || !fs.existsSync(mediaPath)) {
    return encodeOutboundMessageBytes(text, type);
  }
  try {
    const fileLen = fs.statSync(mediaPath).size;
    const caption = String(text || content?.caption || "");
    const mime = content.mimetype || "application/octet-stream";
    if (type === "audio") {
      return proto.Message.encode(
        proto.Message.create({
          audioMessage: {
            mimetype: mime,
            ptt: !!content.ptt,
            fileLength: fileLen,
            seconds: 0,
          },
        })
      ).finish();
    }
    if (type === "image") {
      return proto.Message.encode(
        proto.Message.create({
          imageMessage: {
            mimetype: mime,
            caption,
            fileLength: fileLen,
          },
        })
      ).finish();
    }
    if (type === "video") {
      return proto.Message.encode(
        proto.Message.create({
          videoMessage: {
            mimetype: mime,
            caption,
            fileLength: fileLen,
          },
        })
      ).finish();
    }
    if (type === "document") {
      return proto.Message.encode(
        proto.Message.create({
          documentMessage: {
            mimetype: mime,
            caption,
            fileName: content.fileName || "documento",
            fileLength: fileLen,
          },
        })
      ).finish();
    }
  } catch {
    /* fall through */
  }
  return encodeOutboundMessageBytes(text, type);
}

async function persistStoredMessage(sessionId, message, messageBytes) {
  if (!message?.id) return;
  try {
    await ensureShared();
    const bundle = sharedStore.session(sessionId);
    const existing = await bundle.messages.getById(message.id);
    const bytes =
      messageBytes ||
      existing?.messageBytes ||
      encodeOutboundMessageBytes(message.text, message.type);
    if (!bytes?.length) return;
    const useBytes =
      existing?.messageBytes?.length > (bytes?.length || 0) ? existing.messageBytes : bytes;
    const fromMe = !!(message.fromMe || existing?.fromMe);
    const threadCandidates = [
      message.chatJid,
      message.chatJidAlt,
      ...expandChatJids(sessionId, message.chatJid || ""),
    ].filter(Boolean);
    const threadJid =
      threadCandidates.find((j) => j && !String(j).includes("@lid") && !isStatusJid(j)) ||
      threadCandidates[0] ||
      message.chatJid;
    const tsMs =
      Number(message.timestampMs || 0) ||
      (message.timestampSeconds || Math.floor(Date.now() / 1000)) * 1000;

    // Gravação direta no Postgres (proto criptografado do WhatsApp em BYTEA)
    if (pgBackend?.pool) {
      await ensureMessageIndexTable();
      const msgTable = `"${ZAPO_TABLE_PREFIX}mailbox_messages"`;
      await pgBackend.pool.query(
        `INSERT INTO ${msgTable} (
          session_id, message_id, thread_jid, sender_jid, participant_jid, from_me, timestamp_ms, message_bytes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (session_id, message_id) DO UPDATE SET
          thread_jid = COALESCE(NULLIF(EXCLUDED.thread_jid, ''), ${msgTable}.thread_jid),
          from_me = (${msgTable}.from_me OR EXCLUDED.from_me),
          timestamp_ms = GREATEST(COALESCE(${msgTable}.timestamp_ms, 0), COALESCE(EXCLUDED.timestamp_ms, 0)),
          message_bytes = CASE
            WHEN EXCLUDED.message_bytes IS NOT NULL
              AND length(EXCLUDED.message_bytes) >= COALESCE(length(${msgTable}.message_bytes), 0)
            THEN EXCLUDED.message_bytes
            ELSE ${msgTable}.message_bytes
          END`,
        [
          sessionId,
          message.id,
          threadJid || message.chatJid || "",
          message.participant || null,
          message.participant || null,
          fromMe,
          tsMs,
          Buffer.from(useBytes),
        ]
      );
    }

    await bundle.messages.upsert({
      id: message.id,
      threadJid,
      fromMe,
      timestampMs: tsMs,
      messageBytes: useBytes,
      participantJid: message.participant || undefined,
    });
    for (const alt of threadCandidates) {
      if (alt && alt !== threadJid) linkJidAliases(sessionId, threadJid, alt);
    }
    await persistMessageThreadIndex(sessionId, message.id, threadCandidates);
  } catch (err) {
    console.warn("persistStoredMessage", err?.message || err);
  }
}

const persistOutboundMessage = persistStoredMessage;

function rowToStoredMessage(row) {
  return decodeStoredMessage({
    id: row.message_id,
    threadJid: row.thread_jid,
    senderJid: row.sender_jid,
    participantJid: row.participant_jid,
    fromMe: row.from_me,
    timestampMs: row.timestamp_ms != null ? Number(row.timestamp_ms) : undefined,
    messageBytes: row.message_bytes,
  });
}

/** Busca mensagem por id em qualquer thread da sessão (pai de reação fora do window/jid). */
async function loadStoredMessageById(sessionId, messageId) {
  if (!pgBackend?.pool || !messageId) return null;
  try {
    const table = `"${ZAPO_TABLE_PREFIX}mailbox_messages"`;
    const { rows } = await pgBackend.pool.query(
      `SELECT message_id, thread_jid, sender_jid, participant_jid, from_me, timestamp_ms, message_bytes
       FROM ${table}
       WHERE session_id = $1 AND message_id = $2
       LIMIT 1`,
      [sessionId, messageId]
    );
    if (rows?.[0]) return rowToStoredMessage(rows[0]);
  } catch (err) {
    console.warn("loadStoredMessageById", err?.message || err);
  }
  try {
    await ensureShared();
    const rec = await sharedStore.session(sessionId).messages.getById(messageId);
    if (rec?.messageBytes?.length) {
      return decodeStoredMessage({
        id: rec.id || messageId,
        threadJid: rec.threadJid || "",
        senderJid: rec.senderJid,
        participantJid: rec.participantJid,
        fromMe: !!rec.fromMe,
        timestampMs: rec.timestampMs,
        messageBytes: rec.messageBytes,
      });
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Garante que o alvo da reação exista nesta sessão (senão o fold no UI some com o chip).
 * Cria stub mínimo se o pai nunca sincronizou (envio noutro dispositivo/painel).
 */
async function ensureReactionTargetMessage(sessionId, reactionSerialized) {
  const targetId = String(reactionSerialized?.reaction?.targetId || "").trim();
  if (!targetId) return null;
  const chatJid = reactionSerialized.chatJid || "";
  const existing = await loadStoredMessageById(sessionId, targetId);
  if (existing?.id) {
    // Garante índice no thread atual (LID↔PN) para listMessages achar o pai.
    if (chatJid) {
      await persistMessageThreadIndex(sessionId, targetId, [
        chatJid,
        existing.chatJid,
        reactionSerialized.reaction?.targetRemoteJid,
      ]);
      const slot = sessions.get(sessionId);
      if (slot) {
        cacheMessage(
          slot,
          { ...existing, chatJid: existing.chatJid || chatJid },
          sessionId,
          [chatJid]
        );
      }
    }
    return existing;
  }
  const ts =
    Math.max(0, (Number(reactionSerialized.timestampMs) || Date.now()) - 1000) ||
    Date.now() - 1000;
  // Reação recebida → quase sempre mira mensagem nossa; key.fromMe no LID mente às vezes.
  const fromMe = reactionSerialized.fromMe
    ? !!reactionSerialized.reaction?.targetFromMe
    : true;
  const stub = {
    id: targetId,
    chatJid: chatJid || reactionSerialized.reaction?.targetRemoteJid || "",
    fromMe,
    type: "text",
    text: "",
    timestampMs: ts,
    timestampSeconds: Math.floor(ts / 1000),
    ackStatus: fromMe ? "sent" : "",
  };
  await persistStoredMessage(sessionId, stub, encodeOutboundMessageBytes("", "text"));
  const slot = sessions.get(sessionId);
  if (slot) cacheMessage(slot, stub, sessionId, [chatJid]);
  return stub;
}

/** Remove campos internos antes de responder JSON ao painel. */
function publicMessages(messages) {
  return (messages || []).map((m) => {
    if (!m || typeof m !== "object") return m;
    const { _message, ...rest } = m;
    return rest;
  });
}

/** List messages for any alias of a chat in one SQL pass (restart-safe). */
async function listStoredMessagesForJids(sessionId, jids, limit = 80, beforeMs) {
  if (!pgBackend?.pool || !jids?.size) return [];
  try {
    await ensureAliasTable();
    await ensureMessageIndexTable();
    const table = `"${ZAPO_TABLE_PREFIX}mailbox_messages"`;
    const indexTable = `"${ZAPO_TABLE_PREFIX}message_threads"`;
    const aliasTable = `"${ZAPO_TABLE_PREFIX}jid_aliases"`;
    const contactTable = `"${ZAPO_TABLE_PREFIX}mailbox_contacts"`;
    const list = [...jids].filter(Boolean);
    const resolvedLimit = Math.max(limit, 80);
    const phones = new Set();
    for (const j of list) {
      const p =
        resolveJidPhone(sessionId, j, null) ||
        phoneFromJid(j) ||
        "";
      if (String(p).replace(/\D/g, "").length >= 10) phones.add(String(p).replace(/\D/g, ""));
    }
    const phoneList = [...phones];

    const params = [sessionId, list];
    let sql = `SELECT DISTINCT m.message_id, m.thread_jid, m.sender_jid, m.participant_jid,
        m.from_me, m.timestamp_ms, m.message_bytes
      FROM ${table} m
      LEFT JOIN ${indexTable} t
        ON t.session_id = m.session_id AND t.message_id = m.message_id
      WHERE m.session_id = $1 AND (
        m.thread_jid = ANY($2::text[])
        OR t.thread_jid = ANY($2::text[])`;
    if (phoneList.length) {
      params.push(phoneList);
      sql += `
        OR EXISTS (
          SELECT 1 FROM ${contactTable} c
          WHERE c.session_id = $1
            AND (c.jid = m.thread_jid OR c.lid = m.thread_jid)
            AND c.phone_number = ANY($${params.length}::text[])
        )`;
    }
    sql += `
        OR EXISTS (
          SELECT 1 FROM ${aliasTable} a
          WHERE a.session_id = $1
            AND (
              (a.jid_a = m.thread_jid AND a.jid_b = ANY($2::text[]))
              OR (a.jid_b = m.thread_jid AND a.jid_a = ANY($2::text[]))
            )
        )
      )`;
    if (beforeMs) {
      params.push(beforeMs);
      sql += ` AND m.timestamp_ms < $${params.length}`;
    }
    params.push(resolvedLimit);
    sql += ` ORDER BY m.timestamp_ms DESC, m.message_id DESC LIMIT $${params.length}`;

    const { rows } = await pgBackend.pool.query(sql, params);
    const byId = new Map();
    for (const row of rows || []) {
      const decoded = rowToStoredMessage(row);
      if (decoded?.id) byId.set(decoded.id, decoded);
    }

    if (byId.size < resolvedLimit) {
      const targetKeys = new Set();
      for (const j of list) {
        const k = canonicalChatKey(sessionId, j);
        if (k) targetKeys.add(k);
      }
      if (targetKeys.size) {
        const fbLimit = Math.min(800, resolvedLimit * 6);
        const fbParams = beforeMs ? [sessionId, fbLimit, beforeMs] : [sessionId, fbLimit];
        const fbSql = `SELECT message_id, thread_jid, sender_jid, participant_jid, from_me, timestamp_ms, message_bytes
          FROM ${table}
          WHERE session_id = $1${beforeMs ? " AND timestamp_ms < $3" : ""}
          ORDER BY timestamp_ms DESC, message_id DESC
          LIMIT $2`;
        const { rows: recent } = await pgBackend.pool.query(fbSql, fbParams);
        for (const row of recent || []) {
          const key = canonicalChatKey(sessionId, row.thread_jid);
          if (!targetKeys.has(key)) continue;
          const decoded = rowToStoredMessage(row);
          if (decoded?.id && !byId.has(decoded.id)) byId.set(decoded.id, decoded);
        }
      }
    }

    return [...byId.values()]
      .sort(compareMessagesAsc)
      .slice(-resolvedLimit);
  } catch (err) {
    console.warn("listStoredMessagesForJids", err?.message || err);
    return [];
  }
}

function cacheMessage(slot, serialized, sessionId, extraJids = []) {
  const keys = expandChatJids(sessionId || "", serialized.chatJid);
  for (const j of extraJids) if (j) keys.add(String(j));
  if (!keys.size && serialized.chatJid) keys.add(serialized.chatJid);
  for (const jid of keys) {
    let arr = slot.msgCache.get(jid);
    if (!arr) {
      arr = [];
      slot.msgCache.set(jid, arr);
    }
    if (arr.some((m) => m.id === serialized.id)) continue;
    arr.push(serialized);
    if (arr.length > MSG_CACHE_PER_CHAT) arr.splice(0, arr.length - MSG_CACHE_PER_CHAT);
  }
}

async function ensureShared() {
  if (sharedStore) return;
  const pgUrl = resolveDatabaseUrl();
  if (!pgUrl) {
    throw new Error(
      "DATABASE_URL (ou ZAPO_DATABASE_URL) obrigatória — gateway Zapo usa PostgreSQL, sem SQLite"
    );
  }
  sharedLogger = await createPinoLogger({ level: "info" });
  try {
    mediaProcessor = createMediaProcessor({
      ffmpegPath,
      ffprobePath,
    });
    console.log(
      `[wa-gateway] media-utils ok (ffmpeg=${ffmpegPath}, ffprobe=${ffprobePath})`
    );
  } catch (err) {
    console.warn("media-utils unavailable:", err?.message || err);
    mediaProcessor = null;
  }
  pgBackend = createPostgresStore({
    pool: { connectionString: pgUrl },
    tablePrefix: ZAPO_TABLE_PREFIX,
    logger: sharedLogger,
  });
  sharedStore = createStore({
    backends: {
      postgres: pgBackend,
    },
    providers: {
      auth: "postgres",
      signal: "postgres",
      preKey: "postgres",
      session: "postgres",
      identity: "postgres",
      senderKey: "postgres",
      appState: "postgres",
      privacyToken: "postgres",
      messages: "postgres",
      threads: "postgres",
      contacts: "postgres",
    },
  });
}

/**
 * @param {string} sessionId
 * @param {{ history?: boolean }} opts
 */
async function getOrCreateSession(sessionId, opts = {}) {
  await ensureShared();
  let slot = sessions.get(sessionId);
  if (slot) return slot;

  const isAdmin = sessionId === ADMIN_SESSION;
  // Sem sync de histórico antigo — só mensagens ao vivo após conectar
  const historyEnabled = false;

  const clientOpts = {
    store: sharedStore,
    sessionId,
    connectTimeoutMs: 20_000,
    nodeQueryTimeoutMs: 30_000,
    recoverFromClientTooOld: true,
    history: { enabled: historyEnabled, requireFullSync: false },
    linkPreview: { enabled: true, fetchTimeoutMs: 8_000 },
  };
  if (mediaProcessor) {
    clientOpts.media = {
      processor: mediaProcessor,
      normalizeVoiceNote: true,
      generateWaveform: true,
    };
  }

  const wa = new WaClient(clientOpts, sharedLogger);

  /** @type {SessionSlot} */
  slot = {
    client: wa,
    status: "idle",
    qr: "",
    qrPng: "",
    meJid: "",
    pushName: "",
    error: "",
    connecting: false,
    reconnectTimer: null,
    qrTimer: null,
    eventClients: new Set(),
    wsClients: new Set(),
    msgCache: new Map(),
  };
  sessions.set(sessionId, slot);

  try {
    pgBackend?.startCleanup(sessionId);
  } catch (err) {
    console.warn("startCleanup", err?.message || err);
  }

  const QR_IDLE_MS = 120_000;
  function clearQrTimer() {
    if (slot.qrTimer) {
      clearTimeout(slot.qrTimer);
      slot.qrTimer = null;
    }
  }

  wa.on("auth_qr", async ({ qr }) => {
    slot.status = "qr";
    slot.qr = qr;
    try {
      slot.qrPng = await QRCode.toDataURL(qr, { margin: 1, width: 280 });
    } catch {
      slot.qrPng = "";
    }
    broadcast(slot, "auth_qr", { qr: slot.qr, qrPng: slot.qrPng });
    clearQrTimer();
    slot.qrTimer = setTimeout(async () => {
      slot.qrTimer = null;
      if (slot.status !== "qr") return;
      console.log(`[wa-gateway] QR idle timeout (${QR_IDLE_MS / 1000}s) → ${sessionId}`);
      try {
        await slot.client.disconnect();
      } catch {
        /* ignore */
      }
      slot.status = "idle";
      slot.qr = "";
      slot.qrPng = "";
      slot.error = "QR expirado (2 min). Abra novamente para conectar.";
      broadcast(slot, "connection", { status: "idle", qrExpired: true });
    }, QR_IDLE_MS);
  });

  wa.on("auth_paired", ({ credentials }) => {
    clearQrTimer();
    slot.meJid = normalizeUserJid(credentials?.meJid || "") || credentials?.meJid || "";
    slot.pushName = String(
      credentials?.pushName || credentials?.meDisplayName || ""
    ).trim();
    slot.qr = "";
    slot.qrPng = "";
    slot.status = "open";
    slot.error = "";
    broadcast(slot, "auth_paired", { meJid: slot.meJid, pushName: slot.pushName });
  });

  wa.on("connection", (event) => {
    if (event.status === "open") {
      clearQrTimer();
      slot.status = "open";
      slot.qr = "";
      slot.qrPng = "";
      slot.error = "";
      syncSlotIdentity(slot)
        .then(() =>
          // App-state pode popular pushName/meDisplayName um pouco depois do open
          new Promise((r) => setTimeout(r, 800)).then(() => syncSlotIdentity(slot))
        )
        .catch(() => null);
      broadcast(slot, "connection", { status: "open", meJid: slot.meJid, pushName: slot.pushName });
      return;
    }
    slot.status = "close";
    broadcast(slot, "connection", { status: "close", isLogout: !!event.isLogout });
    if (event.isLogout) {
      clearQrTimer();
      slot.meJid = "";
      slot.pushName = "";
      slot.error = "Dispositivo desvinculado. Escaneie o QR de novo.";
      return;
    }
    scheduleReconnect(sessionId);
  });

  wa.on("message", async (event) => {
    rememberLidPhone(sessionId, event);
    const serialized = serializeMessage(event);
    if (serialized.chatJid && serialized.chatJidAlt) {
      linkJidAliases(sessionId, serialized.chatJid, serialized.chatJidAlt);
    }
    if (serialized.isStatus || isStatusJid(serialized.chatJid)) {
      const feed = rememberStatusItem(sessionId, serialized);
      rememberMediaPayload(sessionId, event, serialized);
      broadcast(slot, "status", { feed, item: serialized });
      return;
    }
    if (isNoiseJid(serialized.chatJid)) {
      return;
    }

    // Protocolo interno (chaves de grupo, etc.) — não vira bolha nem polui DM
    if (
      serialized.type === "skdm" ||
      serialized.type === "protocol" ||
      serialized.type === "poll_update"
    ) {
      return;
    }

    // Reações: não viram bolha — anexam à mensagem alvo
    if (serialized.type === "reaction") {
      const preferred = preferChatJid(sessionId, serialized.chatJid, serialized.chatJidAlt);
      const withChat = { ...serialized, chatJid: preferred || serialized.chatJid };
      await ensureReactionTargetMessage(sessionId, withChat);
      const payload = {
        id: serialized.id,
        chatJid: preferred || serialized.chatJid,
        chatJidAlt:
          serialized.chatJidAlt ||
          (preferred && preferred !== serialized.chatJid ? serialized.chatJid : "") ||
          "",
        targetId: serialized.reaction?.targetId || "",
        emoji: serialized.reaction?.text || serialized.text || "",
        fromMe: !!serialized.fromMe,
        participant: serialized.participant || "",
        pushName: serialized.pushName || "",
        timestampSeconds: serialized.timestampSeconds,
      };
      broadcast(slot, "reaction", payload);
      // Persiste só para reidratar no reload (UI faz fold)
      if (preferred || serialized.chatJid) {
        let bytes = null;
        try {
          if (event.message) bytes = proto.Message.encode(event.message).finish();
        } catch {
          bytes = null;
        }
        await persistStoredMessage(sessionId, withChat, bytes);
      }
      invalidateChatsCache(sessionId);
      return;
    }

    rememberMediaPayload(sessionId, event, serialized);
    if (serialized.isGroup && !serialized.fromMe) {
      serialized.pushName = await resolveSenderDisplayName(
        sessionId,
        serialized.participant,
        serialized.participantAlt,
        serialized.pushName
      );
      if (serialized.pushName && serialized.participant) {
        void rememberContactPushName(
          sessionId,
          serialized.participant,
          serialized.pushName,
          resolveJidPhone(sessionId, serialized.participant, null) ||
            resolveJidPhone(sessionId, serialized.participantAlt, null)
        );
      }
    }
    cacheMessage(slot, serialized, sessionId, [serialized.chatJidAlt]);
    if (serialized.chatJid) {
      const preferred = preferChatJid(sessionId, serialized.chatJid, serialized.chatJidAlt);
      const isGroup = !!serialized.isGroup || isGroupJid(preferred);
      // fromMe: pushName is OUR name — never use it as the peer chat title
      // groups: title comes from subject/metadata, not sender pushName
      const peerName = serialized.fromMe || isGroup ? "" : serialized.pushName || "";
      void ensureThreadRecord(sessionId, preferred, peerName, { isGroup });
      rememberPanelChat(sessionId, {
        jid: preferred,
        name: peerName,
        isGroup,
        openedAt: Date.now(),
        fromMe: !!serialized.fromMe,
      });
      if (!serialized.fromMe) {
        void bumpUnreadForChat(sessionId, preferred || serialized.chatJid);
      }
      if (!serialized.fromMe && serialized.pushName && !serialized.isGroup) {
        void rememberContactPushName(
          sessionId,
          preferred || serialized.chatJid,
          serialized.pushName,
          resolveJidPhone(sessionId, preferred || serialized.chatJid, null)
        );
      }
      let bytes = null;
      try {
        if (event.message) bytes = proto.Message.encode(event.message).finish();
      } catch {
        bytes = null;
      }
      await persistStoredMessage(sessionId, { ...serialized, chatJid: preferred || serialized.chatJid }, bytes);
    }
    const preferredOut = preferChatJid(sessionId, serialized.chatJid, serialized.chatJidAlt);
    broadcast(slot, "message", {
      ...serialized,
      chatJid: preferredOut || serialized.chatJid,
      chatJidAlt:
        serialized.chatJidAlt ||
        (preferredOut && preferredOut !== serialized.chatJid ? serialized.chatJid : "") ||
        "",
    });
    invalidateChatsCache(sessionId);
    if (isAdmin) void forwardInboundAdmin(event);
  });

  wa.on("message_addon", (event) => {
    try {
      if (event?.kind !== "reaction") return;
      const chatJid = preferChatJid(
        sessionId,
        event.key?.remoteJid || "",
        event.key?.remoteJidAlt || ""
      );
      if (!chatJid || isNoiseJid(chatJid) || isStatusJid(chatJid)) return;
      const emoji = String(event.decrypted?.reaction?.text || "");
      const targetId = String(
        event.targetMessageId || event.decrypted?.reaction?.key?.id || ""
      );
      const targetFromMe = !!event.decrypted?.reaction?.key?.fromMe;
      void ensureReactionTargetMessage(sessionId, {
        chatJid,
        fromMe: !!event.key?.fromMe,
        timestampMs: (event.timestampSeconds || Math.floor(Date.now() / 1000)) * 1000,
        reaction: {
          text: emoji,
          targetId,
          targetFromMe,
          targetRemoteJid: String(event.decrypted?.reaction?.key?.remoteJid || ""),
        },
      });
      broadcast(slot, "reaction", {
        id: event.key?.id || "",
        chatJid,
        targetId,
        emoji,
        fromMe: !!event.key?.fromMe,
        participant: event.key?.participant || "",
        pushName: event.pushName || "",
        timestampSeconds: event.timestampSeconds || Math.floor(Date.now() / 1000),
      });
      invalidateChatsCache(sessionId);
    } catch (err) {
      console.warn("message_addon reaction", err?.message || err);
    }
  });

  wa.on("message_send", async (event) => {
    try {
      const serialized = serializeMessage(event);
      if (!serialized.id) return;
      if (serialized.isStatus || isStatusJid(serialized.chatJid)) {
        rememberStatusItem(sessionId, serialized);
        rememberMediaPayload(sessionId, event, serialized);
        return;
      }
      if (isNoiseJid(serialized.chatJid)) {
        return;
      }
      if (
        serialized.type === "skdm" ||
        serialized.type === "protocol" ||
        serialized.type === "poll_update"
      ) {
        return;
      }
      if (serialized.chatJid && serialized.chatJidAlt) {
        linkJidAliases(sessionId, serialized.chatJid, serialized.chatJidAlt);
      }
      const preferred = preferChatJid(sessionId, serialized.chatJid, serialized.chatJidAlt);
      // Reações outbound: persiste como reaction (não bolha) + garante pai
      if (serialized.type === "reaction") {
        const withChat = { ...serialized, chatJid: preferred || serialized.chatJid, fromMe: true };
        await ensureReactionTargetMessage(sessionId, withChat);
        let bytes = null;
        try {
          if (event.message) bytes = proto.Message.encode(event.message).finish();
        } catch {
          bytes = null;
        }
        if (!bytes?.length) {
          bytes = encodeOutboundReactionBytes(serialized.reaction?.text || serialized.text, {
            remoteJid: serialized.reaction?.targetRemoteJid || preferred || serialized.chatJid,
            id: serialized.reaction?.targetId,
            fromMe: serialized.reaction?.targetFromMe,
            participant: serialized.reaction?.targetParticipant,
          });
        }
        await persistStoredMessage(sessionId, withChat, bytes);
        invalidateChatsCache(sessionId);
        return;
      }
      serialized.ackStatus = "sent";
      serialized.fromPhone = false;
      rememberMediaPayload(sessionId, event, serialized);
      cacheMessage(slot, serialized, sessionId, [serialized.chatJidAlt]);
      if (preferred) {
        rememberPanelChat(sessionId, {
          jid: preferred,
          name: "",
          isGroup: !!serialized.isGroup,
          openedAt: Date.now(),
          fromMe: true,
        });
      }
      let bytes = null;
      try {
        if (event.message) bytes = proto.Message.encode(event.message).finish();
      } catch {
        bytes = null;
      }
      await persistStoredMessage(sessionId, { ...serialized, chatJid: preferred || serialized.chatJid }, bytes);
    } catch {
      /* ignore */
    }
  });

  wa.on("receipt", (event) => {
    try {
      const updated = applyReceiptToCache(slot, sessionId, event || {});
      if (updated.length) broadcast(slot, "receipt", { updates: updated, raw: { status: event.status } });
    } catch {
      /* ignore */
    }
  });

  wa.on("group", (event) => {
    try {
      const groupJid = String(event?.groupJid || event?.jid || "").trim();
      const subject = pickGroupSubject(
        event?.subject,
        event?.group?.subject,
        event?.metadata?.subject,
        event?.name
      );
      if (groupJid && isGroupJid(groupJid) && subject) {
        void applyGroupSubject(sessionId, groupJid, subject).then(() => {
          invalidateChatsCache(sessionId);
          broadcast(slot, "group", { ...event, subject, groupJid });
        });
      } else {
        broadcast(slot, "group", event);
      }
    } catch {
      /* ignore */
    }
  });

  for (const ev of ["presence", "mutation", "history_sync_chunk", "call", "chatstate"]) {
    wa.on(ev, (payload) => {
      try {
        broadcast(slot, ev, payload);
      } catch {
        /* ignore circular */
      }
    });
  }

  return slot;
}

function scheduleReconnect(sessionId) {
  const slot = sessions.get(sessionId);
  if (!slot || slot.reconnectTimer) return;
  slot.reconnectTimer = setTimeout(async () => {
    slot.reconnectTimer = null;
    try {
      await ensureConnected(sessionId);
    } catch (err) {
      slot.error = String(err?.message || err);
    }
  }, 4000);
}

async function ensureConnected(sessionId, opts = {}) {
  const slot = await getOrCreateSession(sessionId, opts);
  if (slot.connecting) return slot;
  slot.connecting = true;
  if (slot.status !== "open") slot.status = "connecting";
  try {
    await slot.client.connect();
  } finally {
    slot.connecting = false;
  }
  return slot;
}

async function forwardInboundAdmin(event) {
  try {
    if (!event || event.key?.fromMe) return;
    if (event.key?.isGroup || event.key?.isBroadcast || event.key?.isNewsletter) return;
    const text = String(extractText(event.message) || "").trim();
    if (!text) return;
    const remote = String(event.key?.remoteJid || "");
    const phone = resolvePhone(event);
    if (phone.length < 10) {
      console.warn("inbound sem telefone (LID sem mapa) — ignorado");
      return;
    }
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (INBOUND_SECRET) headers["X-Zapo-Secret"] = INBOUND_SECRET;
    const res = await fetch(INBOUND_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ phone, text, jid: remote }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn("inbound flask", res.status, body.slice(0, 200));
    }
  } catch (err) {
    console.warn("inbound forward", err?.message || err);
  }
}

function publicStatus(slot, sessionId) {
  return {
    ok: true,
    sessionId,
    status: slot?.status || "idle",
    meJid: slot?.meJid || "",
    pushName: slot?.pushName || "",
    qr: slot?.qr || "",
    qrPng: slot?.qrPng || "",
    error: slot?.error || "",
    inbound: sessionId === ADMIN_SESSION,
    inboundVersion: INBOUND_VERSION,
  };
}

async function downloadToTemp(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dest = path.join(os.tmpdir(), `sf-wa-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  fs.writeFileSync(dest, buf);
  return dest;
}

async function adminSend({ phone, caption, imageUrl }) {
  const slot = await ensureConnected(ADMIN_SESSION, { history: false });
  if (slot.status !== "open") throw new Error("WhatsApp não está conectado");
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 10) throw new Error("Número inválido");
  const jid = `${digits}@s.whatsapp.net`;
  rememberPhone(jid, digits);
  const text = String(caption || "").trim() || "SteamFarm";
  if (imageUrl) {
    let file = "";
    try {
      file = await downloadToTemp(imageUrl);
      await slot.client.message.send(jid, {
        type: "image",
        media: file,
        mimetype: "image/jpeg",
        caption: text,
      });
    } finally {
      if (file) try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
    return;
  }
  await slot.client.message.send(jid, text);
}

function panelChatsFor(sessionId) {
  let m = panelChatMaps.get(sessionId);
  if (!m) {
    m = new Map();
    panelChatMaps.set(sessionId, m);
  }
  return m;
}

function pickGroupSubject(...candidates) {
  for (const c of candidates) {
    const s = String(c || "").trim();
    if (!s) continue;
    if (s.includes("@")) continue;
    if (/^\d{8,}(@|$)/.test(s)) continue;
    return s;
  }
  return "";
}

function rememberPanelChat(sessionId, chat) {
  const jid = String(chat?.jid || "");
  if (!jid || isNoiseJid(jid)) return;
  const map = panelChatsFor(sessionId);
  // Collapse LID + phone into one panel entry keyed by preferred jid
  const preferred = preferChatJid(sessionId, jid, "");
  const key = preferred || jid;
  // Drop sibling alias keys so list doesn't show duplicates
  for (const alt of expandChatJids(sessionId, key)) {
    if (alt !== key && map.has(alt)) {
      const old = map.get(alt);
      map.delete(alt);
      if (!map.has(key)) map.set(key, { ...old, jid: key });
    }
  }
  const prev = map.get(key) || {};
  const incomingName = String(chat.name || "").trim();
  const isGroup = !!chat.isGroup || isGroupJid(key);
  const forceName = !!chat.forceName;
  // Grupos: subject da API (Zapo queryAllGroups/queryGroupMetadata) vence nome antigo
  // (antes prev.name || incoming travava pushName de participante tipo "Rafael Januario")
  let nextName;
  if (isGroup) {
    if (forceName && incomingName) {
      nextName = pickGroupSubject(incomingName) || incomingName;
    } else {
      nextName =
        pickGroupSubject(incomingName, prev.name) || incomingName || prev.name || "";
    }
  } else if (chat.fromMe && !incomingName) {
    nextName = prev.name || "";
  } else {
    nextName = incomingName || prev.name || "";
  }
  map.set(key, {
    jid: key,
    name: nextName,
    phone: chat.phone || prev.phone || "",
    phoneDisplay: chat.phoneDisplay || prev.phoneDisplay || "",
    isGroup,
    kind: chat.kind || (isGroup ? "group" : "dm"),
    pinned: chat.pinned ?? prev.pinned ?? 0,
    unreadCount:
      chat.unreadCount !== undefined && chat.unreadCount !== null
        ? Number(chat.unreadCount) || 0
        : prev.unreadCount ?? 0,
    archived: chat.archived ?? prev.archived ?? false,
    muteEndMs: chat.muteEndMs ?? prev.muteEndMs ?? 0,
    markedAsUnread: chat.markedAsUnread ?? prev.markedAsUnread ?? false,
    openedAt: chat.openedAt || prev.openedAt || Date.now(),
  });
}

function openViewsFor(sessionId) {
  let s = openChatViews.get(sessionId);
  if (!s) {
    s = new Set();
    openChatViews.set(sessionId, s);
  }
  return s;
}

function isChatViewedOpen(sessionId, jid) {
  const views = openViewsFor(sessionId);
  if (views.has(String(jid || ""))) return true;
  for (const a of expandChatJids(sessionId, jid)) {
    if (views.has(a)) return true;
  }
  return false;
}

async function bumpUnreadForChat(sessionId, jid) {
  if (!jid || isChatViewedOpen(sessionId, jid)) return;
  const preferred = preferChatJid(sessionId, jid, "") || jid;
  const prev = panelChatsFor(sessionId).get(preferred) || {};
  const next = (Number(prev.unreadCount) || 0) + 1;
  rememberPanelChat(sessionId, {
    jid: preferred,
    unreadCount: next,
    fromMe: false,
    openedAt: Date.now(),
  });
  try {
    await ensureShared();
    const bundle = sharedStore.session(sessionId);
    const existing = await bundle.threads.getByJid(preferred);
    if (existing) {
      await bundle.threads.upsert({
        ...existing,
        unreadCount: (Number(existing.unreadCount) || 0) + 1,
      });
    }
  } catch (err) {
    console.warn("bumpUnreadForChat", err?.message || err);
  }
}

async function markSessionChatRead(sessionId, jid) {
  const preferred = preferChatJid(sessionId, jid, "") || jid;
  const views = new Set([preferred, jid, ...expandChatJids(sessionId, preferred)]);
  openChatViews.set(sessionId, views);
  rememberPanelChat(sessionId, { jid: preferred, unreadCount: 0, fromMe: true });
  try {
    const slot = sessions.get(sessionId);
    if (slot?.status === "open") {
      await slot.client.chat.setChatRead(preferred, true);
    }
  } catch (err) {
    console.warn("setChatRead", err?.message || err);
  }
  try {
    await ensureShared();
    const bundle = sharedStore.session(sessionId);
    const existing = await bundle.threads.getByJid(preferred);
    if (existing) {
      await bundle.threads.upsert({ ...existing, unreadCount: 0 });
    }
  } catch {
    /* ignore */
  }
  return { ok: true, jid: preferred };
}

async function ensureThreadRecord(sessionId, jid, name = "", { isGroup = false, forceName = false } = {}) {
  if (!jid || !sharedStore) return;
  try {
    const bundle = sharedStore.session(sessionId);
    const existing = await bundle.threads.getByJid(jid);
    const incoming = String(name || "").trim();
    const group = isGroup || isGroupJid(jid);
    let nextName;
    if (group) {
      if (forceName && incoming) nextName = pickGroupSubject(incoming) || incoming;
      else nextName = pickGroupSubject(incoming, existing?.name) || incoming || existing?.name || "";
    } else {
      nextName = incoming || existing?.name || "";
    }
    await bundle.threads.upsert({
      jid,
      name: nextName,
      unreadCount: existing?.unreadCount || 0,
      archived: existing?.archived || false,
      pinned: existing?.pinned || 0,
      muteEndMs: existing?.muteEndMs || 0,
      markedAsUnread: existing?.markedAsUnread || false,
      ephemeralExpiration: existing?.ephemeralExpiration,
      ephemeralSettingTimestamp: existing?.ephemeralSettingTimestamp,
    });
  } catch (err) {
    console.warn("ensureThreadRecord", err?.message || err);
  }
}

async function applyGroupSubject(sessionId, jid, subject) {
  const sub = pickGroupSubject(subject);
  if (!jid || !isGroupJid(jid) || !sub) return false;
  await ensureThreadRecord(sessionId, jid, sub, { isGroup: true, forceName: true });
  rememberPanelChat(sessionId, { jid, name: sub, isGroup: true, kind: "group", forceName: true });
  return true;
}

function chatFromParts(sessionId, t, contact, slot, lastOverride = null) {
  const phone = resolveJidPhone(sessionId, t.jid, contact);
  const phoneDisplay = formatPhoneDisplay(phone);
  const group = !!t.isGroup || isGroupJid(t.jid);
  let savedName = String(contact?.displayName || "").trim();
  if (savedName.includes("@") || savedName === t.jid) savedName = "";
  const threadName = pickGroupSubject(t.name, t.subject);
  const pushName = String(contact?.pushName || "").trim();
  const cached = slot?.msgCache?.get(t.jid) || [];
  const lastCached = cached.length ? cached[cached.length - 1] : null;
  let last = lastOverride || lastCached || null;
  if (lastOverride && lastCached) {
    last =
      messageTimeMs(lastOverride) >= messageTimeMs(lastCached) ? lastOverride : lastCached;
  }
  const livePush =
    !group && last && !last.fromMe ? String(last.pushName || "").trim() : "";
  const push = pushName || livePush;
  const contactName = savedName;
  // Grupos: só subject oficial — nunca contactName/pushName de participante
  const displayName = group
    ? threadName || t.jid.split("@")[0] || t.jid
    : contactName || push || phoneDisplay || phone || t.jid;
  return {
    jid: t.jid,
    name: displayName,
    subject: group ? threadName || displayName : "",
    contactName: group ? "" : contactName || displayName,
    pushName: group ? "" : push && push !== contactName ? push : "",
    phone: phone || "",
    phoneDisplay: phoneDisplay || "",
    unreadCount: t.unreadCount || 0,
    archived: !!t.archived,
    pinned: t.pinned || 0,
    muteEndMs: t.muteEndMs || 0,
    markedAsUnread: !!t.markedAsUnread,
    isGroup: group,
    kind: group ? "group" : "dm",
    avatarUrl: `avatar?jid=${encodeURIComponent(t.jid)}`,
    lastMessage: last
      ? {
          id: last.id,
          text: last.text,
          type: last.type,
          fromMe: last.fromMe,
          timestampSeconds: last.timestampSeconds || Math.floor(messageTimeMs(last) / 1000),
          timestampMs: messageTimeMs(last),
        }
      : null,
  };
}

/** Última mensagem por thread no Postgres (sobrevive restart — msgCache é só memória). */
async function loadLatestMessagesMap(sessionId) {
  const out = new Map();
  if (!pgBackend?.pool) return out;
  try {
    const table = `"${ZAPO_TABLE_PREFIX}mailbox_messages"`;
    const { rows } = await pgBackend.pool.query(
      `SELECT DISTINCT ON (thread_jid)
         message_id, thread_jid, sender_jid, participant_jid, from_me, timestamp_ms, message_bytes
       FROM ${table}
       WHERE session_id = $1
       ORDER BY thread_jid, timestamp_ms DESC, message_id DESC`,
      [sessionId]
    );
    for (const row of rows || []) {
      const decoded = rowToStoredMessage(row);
      if (!decoded?.id) continue;
      const jid = String(row.thread_jid || "");
      if (jid) out.set(jid, decoded);
      const canon = canonicalChatKey(sessionId, jid);
      if (canon) {
        const prev = out.get(`c:${canon}`);
        if (!prev || messageTimeMs(decoded) >= messageTimeMs(prev)) {
          out.set(`c:${canon}`, decoded);
        }
      }
    }
  } catch (err) {
    console.warn("loadLatestMessagesMap", err?.message || err);
  }
  return out;
}

function latestForJid(latestMap, sessionId, jid) {
  if (!latestMap?.size || !jid) return null;
  return (
    latestMap.get(jid) ||
    latestMap.get(`c:${canonicalChatKey(sessionId, jid)}`) ||
    null
  );
}

async function listThreads(sessionId) {
  const slot = await getOrCreateSession(sessionId);
  await hydrateSessionIdentityMaps(sessionId, { force: true });
  const bundle = sharedStore.session(sessionId);
  const byJid = new Map();
  const panelOnly = !!panelOnlyLists.get(sessionId);
  const latestMap = await loadLatestMessagesMap(sessionId);

  if (!panelOnly) {
    const threads = await bundle.threads.list(500);
    for (const t of threads) {
      if (isNoiseJid(t.jid)) continue;
      const contact = await lookupContact(sessionId, t.jid);
      byJid.set(
        t.jid,
        chatFromParts(sessionId, t, contact, slot, latestForJid(latestMap, sessionId, t.jid)),
      );
    }
  }

  // Conversas iniciadas no painel (ainda sem mensagem no store)
  for (const stub of panelChatsFor(sessionId).values()) {
    if (isNoiseJid(stub.jid)) continue;
    if (byJid.has(stub.jid)) {
      const cur = byJid.get(stub.jid);
      const groupRow = stub.isGroup || cur.isGroup;
      byJid.set(stub.jid, {
        ...cur,
        name: groupRow
          ? pickGroupSubject(stub.name, cur.name, cur.subject) || cur.name || stub.name
          : stub.name || cur.name,
        subject: groupRow
          ? pickGroupSubject(stub.name, cur.subject, cur.name) || cur.subject || ""
          : cur.subject || "",
        phone: stub.phone || cur.phone,
        phoneDisplay: stub.phoneDisplay || cur.phoneDisplay,
      });
      continue;
    }
    byJid.set(
      stub.jid,
      chatFromParts(
        sessionId,
        {
          jid: stub.jid,
          name: stub.name,
          unreadCount: stub.unreadCount,
          archived: stub.archived,
          pinned: stub.pinned,
          muteEndMs: stub.muteEndMs,
          markedAsUnread: stub.markedAsUnread,
          isGroup: stub.isGroup,
        },
        await lookupContact(sessionId, stub.jid),
        slot,
        latestForJid(latestMap, sessionId, stub.jid),
      )
    );
  }

  // Grupos da conta via queryAllGroups — só metadados, sem histórico; cache p/ não travar
  if (!panelOnly && slot.status === "open") {
    try {
      const groups = await listGroupsCached(sessionId, slot);
      for (const g of groups || []) {
        const jid = g.jid;
        if (!jid || isNoiseJid(jid)) continue;
        const subject = pickGroupSubject(g.subject, g.name);
        if (subject) {
          await applyGroupSubject(sessionId, jid, subject);
        } else {
          rememberPanelChat(sessionId, {
            jid,
            name: "",
            isGroup: true,
            kind: "group",
          });
        }
        const existing = byJid.get(jid);
        byJid.set(
          jid,
          chatFromParts(
            sessionId,
            {
              jid,
              name: subject || existing?.subject || existing?.name || "",
              subject: subject || existing?.subject || "",
              unreadCount: existing?.unreadCount || 0,
              archived: existing?.archived || false,
              pinned: existing?.pinned || 0,
              muteEndMs: existing?.muteEndMs || 0,
              markedAsUnread: existing?.markedAsUnread || false,
              isGroup: true,
            },
            null,
            slot,
            latestForJid(latestMap, sessionId, jid) || existing?.lastMessage || null,
          )
        );
      }
    } catch (err) {
      console.warn("queryAllGroups", err?.message || err);
    }
  }

  const out = [...byJid.values()];
  // Collapse LID + phone duplicates into one row
  const byCanon = new Map();
  for (const chat of out) {
    const key = canonicalChatKey(sessionId, chat.jid, chat.phone);
    const prev = byCanon.get(key);
    if (!prev) {
      byCanon.set(key, chat);
      continue;
    }
    // Mesma conversa (LID↔PN): jid canônico = telefone quando existir; lastMessage = mais recente (ms)
    const chatIsPn = String(chat.jid || "").includes("@s.whatsapp.net");
    const prevIsPn = String(prev.jid || "").includes("@s.whatsapp.net");
    const keep =
      chatIsPn && !prevIsPn ? chat : prevIsPn && !chatIsPn ? prev : chatIsPn ? chat : prev;
    const drop = keep === chat ? prev : chat;
    const newerLast =
      messageTimeMs(chat.lastMessage) >= messageTimeMs(prev.lastMessage)
        ? chat.lastMessage
        : prev.lastMessage;
    byCanon.set(key, {
      ...keep,
      name: keep.isGroup
        ? pickGroupSubject(keep.subject, keep.name, drop.subject, drop.name) || keep.name || drop.name
        : keep.name || drop.name,
      subject: keep.isGroup
        ? pickGroupSubject(keep.subject, keep.name, drop.subject, drop.name) || keep.subject || ""
        : keep.subject || "",
      contactName: keep.isGroup ? "" : keep.contactName || drop.contactName || "",
      pushName: keep.isGroup ? "" : keep.pushName || drop.pushName || "",
      phone: keep.phone || drop.phone,
      phoneDisplay: keep.phoneDisplay || drop.phoneDisplay,
      unreadCount: Math.max(keep.unreadCount || 0, drop.unreadCount || 0),
      lastMessage: newerLast || keep.lastMessage || drop.lastMessage,
    });
  }
  const deduped = [...byCanon.values()];
  deduped.sort((a, b) => {
    const ap = a.pinned || 0;
    const bp = b.pinned || 0;
    if (ap !== bp) return bp - ap;
    const at =
      messageTimeMs(a.lastMessage) ||
      Number(panelChatsFor(sessionId).get(a.jid)?.openedAt || 0);
    const bt =
      messageTimeMs(b.lastMessage) ||
      Number(panelChatsFor(sessionId).get(b.jid)?.openedAt || 0);
    if (at !== bt) return bt - at;
    return String(a.jid || "").localeCompare(String(b.jid || ""));
  });
  return deduped;
}

function invalidateChatsCache(sessionId) {
  chatsCache.delete(sessionId);
  groupsCache.delete(sessionId);
}

function normalizeGroupJid(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.includes("@")) return s;
  return `${s}@g.us`;
}

function forgetPanelChat(sessionId, jid) {
  const key = String(jid || "").trim();
  if (!key) return;
  const map = panelChatsFor(sessionId);
  const aliases = expandChatJids(sessionId, key);
  aliases.add(key);
  for (const id of aliases) {
    map.delete(id);
  }
}

async function purgeLocalGroupChat(sessionId, jid) {
  forgetPanelChat(sessionId, jid);
  try {
    const slot = await getOrCreateSession(sessionId);
    slot.msgCache?.delete(jid);
  } catch {
    /* ignore */
  }
  try {
    await ensureShared();
    await sharedStore.session(sessionId).threads.deleteByJid(jid);
  } catch (err) {
    console.warn("purgeLocalGroupChat", jid, err?.message || err);
  }
}

async function leaveWhatsAppGroup(client, jid) {
  const bare = jid.includes("@") ? jid.split("@")[0] : jid;
  try {
    await client.group.leaveGroup([bare]);
    return;
  } catch (err1) {
    try {
      await client.group.leaveGroup([jid]);
      return;
    } catch (err2) {
      throw err2 || err1;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedGroupMessagesForDelete(sessionId, slot, jid) {
  await ensureShared();
  const bundle = sharedStore.session(sessionId);
  const canonical = preferChatJid(sessionId, jid, "") || jid;
  const seen = new Set();
  const collected = [];
  for (const key of expandChatJids(sessionId, canonical)) {
    for (const m of slot.msgCache?.get(key) || []) {
      if (m?.id && !seen.has(m.id)) {
        seen.add(m.id);
        collected.push(m);
      }
    }
  }
  for (const m of collected.slice(-80)) {
    const tsMs = (m.timestampSeconds || Math.floor(Date.now() / 1000)) * 1000;
    let messageBytes;
    try {
      const existing = await bundle.messages.getById(m.id);
      if (existing?.messageBytes?.length) messageBytes = existing.messageBytes;
    } catch {
      /* ignore */
    }
    if (!messageBytes?.length) {
      messageBytes = encodeOutboundMessageBytes(String(m.text || m.type || "."), m.type || "text");
    }
    await bundle.messages.upsert({
      id: m.id,
      threadJid: canonical,
      fromMe: !!m.fromMe,
      timestampMs: tsMs,
      messageBytes,
      participantJid: m.participant || undefined,
      senderJid: m.participant || undefined,
    });
  }
}

async function syncAppStateChat(client) {
  try {
    await client.chat.sync({ collections: ["regular_high"] });
  } catch (err) {
    console.warn("syncAppStateChat", err?.message || err);
  }
}

async function deleteGroupConversation(sessionId, slot, client, jid) {
  const targets = [...new Set([preferChatJid(sessionId, jid, "") || jid, jid].filter(Boolean))];
  await seedGroupMessagesForDelete(sessionId, slot, targets[0]);
  await syncAppStateChat(client);

  let lastErr = null;
  for (const id of targets) {
    try {
      await client.chat.setChatArchive(id, false);
    } catch {
      /* ignore */
    }
    try {
      await client.chat.clearChat(id, { deleteMedia: true, deleteStarred: false });
    } catch (err) {
      console.warn("clearChat", id, err?.message || err);
    }
    try {
      await client.chat.deleteChat(id, { deleteMedia: true });
      lastErr = null;
    } catch (err) {
      lastErr = err;
      console.warn("deleteChat", id, err?.message || err);
    }
  }
  await syncAppStateChat(client);
  await sleep(1200);
  if (lastErr) throw lastErr;
}

async function deleteGroupConversationAfterLeave(sessionId, slot, client, jid) {
  const targets = [...new Set([preferChatJid(sessionId, jid, "") || jid, jid].filter(Boolean))];
  for (const id of targets) {
    try {
      await client.chat.deleteChat(id, { deleteMedia: true });
      await syncAppStateChat(client);
      return true;
    } catch (err) {
      console.warn("deleteChat after leave", id, err?.message || err);
    }
  }
  return false;
}

async function applyGroupBulkActions(sessionId, body = {}) {
  const slot = await ensureConnected(sessionId);
  const rawJids = Array.isArray(body.jids) ? body.jids : [];
  const leave = body.leave !== false;
  const deleteChat = body.deleteChat === true;
  const results = [];

  for (const raw of rawJids) {
    const jid = normalizeGroupJid(raw);
    if (!jid || !isGroupJid(jid)) {
      results.push({ jid: String(raw || ""), ok: false, error: "jid de grupo inválido" });
      continue;
    }
    const errors = [];
    let deleted = false;
    // Excluir conversa ANTES de sair — deleteChat precisa do histórico no store p/ sincronizar no celular.
    if (deleteChat) {
      try {
        await deleteGroupConversation(sessionId, slot, slot.client, jid);
        deleted = true;
      } catch (err) {
        errors.push(`excluir: ${err?.message || err}`);
      }
    }
    if (leave) {
      try {
        await leaveWhatsAppGroup(slot.client, jid);
      } catch (err) {
        errors.push(`sair: ${err?.message || err}`);
      }
    }
    if (deleteChat && !deleted) {
      const okAfter = await deleteGroupConversationAfterLeave(sessionId, slot, slot.client, jid);
      if (okAfter) {
        deleted = true;
        for (let i = errors.length - 1; i >= 0; i -= 1) {
          if (errors[i].startsWith("excluir:")) errors.splice(i, 1);
        }
      } else if (!errors.some((e) => e.startsWith("excluir:"))) {
        errors.push("excluir: conversa não foi removida do celular");
      }
    }
    const leftOk = !leave || !errors.some((e) => e.startsWith("sair"));
    const deletedOk = !deleteChat || !errors.some((e) => e.startsWith("excluir"));
    if (leftOk || deletedOk) {
      await purgeLocalGroupChat(sessionId, jid);
    }
    results.push({ jid, ok: !errors.length, error: errors.join("; ") });
  }

  invalidateChatsCache(sessionId);
  const succeeded = results.filter((r) => r.ok).length;
  return {
    ok: succeeded === results.length && results.length > 0,
    processed: results.length,
    succeeded,
    results,
  };
}

async function listThreadsCached(sessionId, { force = false } = {}) {
  if (force) invalidateChatsCache(sessionId);
  const hit = chatsCache.get(sessionId);
  const now = Date.now();
  if (hit?.chats && now - hit.ts < CHATS_CACHE_MS) {
    return hit.chats;
  }
  if (hit?.building) {
    return hit.building;
  }
  const building = listThreads(sessionId)
    .then((chats) => {
      chatsCache.set(sessionId, { ts: Date.now(), chats, building: null });
      return chats;
    })
    .catch((err) => {
      const cur = chatsCache.get(sessionId);
      if (cur) cur.building = null;
      throw err;
    });
  chatsCache.set(sessionId, { ts: hit?.ts || 0, chats: hit?.chats || null, building });
  return building;
}

function mergeGroupLists(...lists) {
  const byJid = new Map();
  for (const list of lists) {
    for (const g of list || []) {
      if (!g?.jid || isNoiseJid(g.jid) || !isGroupJid(g.jid)) continue;
      const prev = byJid.get(g.jid);
      if (!prev) {
        byJid.set(g.jid, { ...g });
        continue;
      }
      byJid.set(g.jid, {
        ...prev,
        ...g,
        subject: pickGroupSubject(g.subject, prev.subject) || String(g.subject || prev.subject || "").trim(),
        participants:
          Array.isArray(g.participants) && g.participants.length
            ? g.participants
            : prev.participants || [],
        size: g.size || prev.size || 0,
      });
    }
  }
  return [...byJid.values()];
}

async function listKnownGroupsLocal(sessionId, slot) {
  const byJid = new Map();
  const add = (jid, subject = "") => {
    if (!jid || isNoiseJid(jid) || !isGroupJid(jid)) return;
    const prev = byJid.get(jid);
    byJid.set(jid, {
      jid,
      subject: pickGroupSubject(subject, prev?.subject) || String(subject || prev?.subject || "").trim(),
      participants: prev?.participants?.length ? prev.participants : [],
      size: prev?.size || 0,
    });
  };
  try {
    await ensureShared();
    const bundle = sharedStore.session(sessionId);
    const threads = await bundle.threads.list(500);
    for (const t of threads || []) add(t.jid, t.name || "");
  } catch (err) {
    console.warn("listKnownGroupsLocal threads", err?.message || err);
  }
  for (const stub of panelChatsFor(sessionId).values()) {
    if (stub.isGroup || isGroupJid(stub.jid)) add(stub.jid, stub.name || "");
  }
  if (slot?.msgCache) {
    for (const jid of slot.msgCache.keys()) {
      if (isGroupJid(jid)) add(jid, panelChatsFor(sessionId).get(jid)?.name || "");
    }
  }
  const chatHit = chatsCache.get(sessionId)?.chats;
  if (Array.isArray(chatHit)) {
    for (const c of chatHit) {
      if (c?.isGroup || isGroupJid(c.jid)) add(c.jid, c.subject || c.name || "");
    }
  }
  return [...byJid.values()];
}

async function listGroupsCached(sessionId, slot, { force = false } = {}) {
  if (force) {
    groupsCache.delete(sessionId);
  }
  const hit = groupsCache.get(sessionId) || {};
  const now = Date.now();
  const rateLimited = (err) => {
    const msg = String(err?.message || err || "");
    return msg.includes("429") || msg.includes("rate-overlimit") || msg.includes("rate limit");
  };
  const localGroups = () => listKnownGroupsLocal(sessionId, slot);

  async function persistGroups(groups, { backoffMs = 0 } = {}) {
    const merged = mergeGroupLists(groups, await localGroups());
    groupsCache.set(sessionId, {
      ts: now,
      groups: merged,
      refreshing: false,
      building: null,
      backoffUntil: backoffMs ? now + backoffMs : 0,
    });
    for (const g of merged) {
      if (g?.jid && g.subject) void applyGroupSubject(sessionId, g.jid, g.subject);
    }
    invalidateChatsCache(sessionId);
    return merged;
  }

  if (!force && hit.backoffUntil && now < hit.backoffUntil) {
    return mergeGroupLists(hit.groups || [], await localGroups());
  }

  const fresh = !force && hit.ts && now - hit.ts < 180_000;
  if (fresh && hit.groups?.length) {
    return mergeGroupLists(hit.groups, await localGroups());
  }

  if (hit.building) {
    try {
      const remote = await hit.building;
      return mergeGroupLists(remote || hit.groups || [], await localGroups());
    } catch {
      return mergeGroupLists(hit.groups || [], await localGroups());
    }
  }

  if (!force && hit.refreshing) {
    return mergeGroupLists(hit.groups || [], await localGroups());
  }

  const runRemote = async () => {
    groupsCache.set(sessionId, {
      ...groupsCache.get(sessionId),
      ts: hit.ts || 0,
      groups: hit.groups || [],
      refreshing: true,
      building: null,
      backoffUntil: hit.backoffUntil || 0,
    });
    try {
      const remote = await slot.client.group.queryAllGroups();
      return persistGroups(remote || [], { backoffMs: 0 });
    } catch (err) {
      if (rateLimited(err)) {
        console.warn("queryAllGroups rate limited — using cache local, pausa 10 min");
        return persistGroups(hit.groups || [], { backoffMs: 600_000 });
      }
      const cur = groupsCache.get(sessionId) || {};
      cur.refreshing = false;
      cur.building = null;
      groupsCache.set(sessionId, cur);
      throw err;
    }
  };

  const building = runRemote();
  groupsCache.set(sessionId, {
    ...groupsCache.get(sessionId),
    building,
  });
  building.finally(() => {
    const cur = groupsCache.get(sessionId);
    if (cur?.building === building) cur.building = null;
  });

  if (!force && hit.groups?.length) {
    // Atualiza em background; devolve o que já temos + threads locais
    return mergeGroupLists(hit.groups, await localGroups());
  }

  try {
    return await building;
  } catch (err) {
    console.warn("queryAllGroups", err?.message || err);
    return mergeGroupLists(hit.groups || [], await localGroups());
  }
}

async function listMessages(sessionId, chatJid, limit = 80, beforeMs) {
  const slot = await getOrCreateSession(sessionId);
  await hydrateSessionIdentityMaps(sessionId, { force: true });
  const jids = expandChatJids(sessionId, chatJid);
  if (!jids.size) jids.add(chatJid);
  const contact = await lookupContact(sessionId, chatJid);
  if (contact?.jid) jids.add(contact.jid);
  if (contact?.lid) jids.add(contact.lid);
  if (contact?.phoneNumber) {
    const pn = String(contact.phoneNumber).replace(/\D/g, "");
    if (pn.length >= 10) {
      jids.add(`${pn}@s.whatsapp.net`);
      rememberLidPhone(sessionId, contact.jid || chatJid, pn);
      if (contact.lid) rememberLidPhone(sessionId, contact.lid, pn);
    }
  }
  const phoneHint = resolveJidPhone(sessionId, chatJid, contact) || phoneFromJid(chatJid);
  if (phoneHint.length >= 10) jids.add(`${phoneHint}@s.whatsapp.net`);
  // Re-expand after contact links
  for (const j of [...expandChatJids(sessionId, chatJid)]) jids.add(j);

  const byId = new Map();
  for (const jid of jids) {
    for (const m of slot.msgCache.get(jid) || []) {
      if (beforeMs && m.timestampSeconds * 1000 >= beforeMs) continue;
      if (m.id) byId.set(m.id, m);
    }
  }
  try {
    const stored = await listStoredMessagesForJids(sessionId, jids, limit, beforeMs);
    for (const decoded of stored) {
      if (!decoded?.id) continue;
      const prev = byId.get(decoded.id);
      if (!prev) {
        byId.set(decoded.id, decoded);
        continue;
      }
      const ts = Math.max(messageTimeMs(decoded), messageTimeMs(prev));
      byId.set(decoded.id, {
        ...decoded,
        ...prev,
        fromMe: !!(prev.fromMe || decoded.fromMe),
        text: decoded.text || prev.text,
        type: decoded.type || prev.type,
        hasMedia: !!(decoded.hasMedia || prev.hasMedia),
        ackStatus: prev.ackStatus || decoded.ackStatus,
        timestampMs: ts,
        timestampSeconds: Math.floor(ts / 1000),
      });
    }
  } catch (err) {
    console.warn("listMessages store", err?.message || err);
  }
  const sorted = [...byId.values()]
    .sort(compareMessagesAsc)
    .slice(-limit);

  // Pais de reação fora do window / noutro jid → reidrata ou cria stub
  for (const m of [...sorted]) {
    if (String(m.type || "").toLowerCase() !== "reaction") continue;
    const tid = String(m.reaction?.targetId || "").trim();
    if (!tid || byId.has(tid)) continue;
    const parent = await ensureReactionTargetMessage(sessionId, m);
    if (parent?.id) byId.set(parent.id, parent);
  }

  const finalSorted = [...byId.values()]
    .sort(compareMessagesAsc)
    .slice(-limit);

  // Reidrata cache em memória após restart (lastMessage / ordem estável)
  for (const m of finalSorted) {
    cacheMessage(slot, m, sessionId, [...jids]);
  }
  return enrichGroupMessageSenders(sessionId, finalSorted);
}

async function resolvePhoneNumber(sessionId, phone) {
  const slot = await ensureConnected(sessionId);
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 10) throw new Error("Número inválido");
  const results = await slot.client.profile.getLidsByPhoneNumbers([digits]);
  const r = results?.[0];
  if (!r || r.invalid) throw new Error("Número inválido");
  if (!r.exists) throw new Error("Número não está no WhatsApp");
  const phoneJid = r.phoneJid || `${digits}@s.whatsapp.net`;
  const lidJid = r.lidJid || "";
  const phoneDigits = phoneFromJid(phoneJid) || digits;
  if (lidJid) rememberLidPhone(sessionId, lidJid, phoneDigits);
  rememberLidPhone(sessionId, phoneJid, phoneDigits);
  linkJidAliases(sessionId, lidJid, phoneJid);
  try {
    const bundle = sharedStore.session(sessionId);
    await bundle.contacts.upsert({
      jid: lidJid || phoneJid,
      lid: lidJid || undefined,
      phoneNumber: phoneDigits,
      lastUpdatedMs: Date.now(),
    });
  } catch {
    /* ignore */
  }
  const jid = lidJid || phoneJid;
  const phoneDisplay = formatPhoneDisplay(phoneDigits);
  await ensureThreadRecord(sessionId, jid, phoneDisplay);
  rememberPanelChat(sessionId, {
    jid,
    name: phoneDisplay,
    phone: phoneDigits,
    phoneDisplay,
    isGroup: false,
    kind: "dm",
    openedAt: Date.now(),
  });
  return {
    ok: true,
    exists: true,
    phone: phoneDigits,
    phoneDisplay,
    phoneJid,
    lidJid,
    jid,
  };
}

function indexGroupParticipants(sessionId, participants) {
  for (const p of participants || []) {
    const phone =
      phoneFromJid(p.phoneNumber) ||
      String(p.phoneNumber || "").replace(/\D/g, "") ||
      phoneFromJid(p.jid);
    if (phone.length < 10) continue;
    if (p.lid) rememberLidPhone(sessionId, p.lid, phone);
    if (p.jid) rememberLidPhone(sessionId, p.jid, phone);
    if (p.phoneNumber) rememberLidPhone(sessionId, p.phoneNumber, phone);
    linkJidAliases(sessionId, p.lid || p.jid, `${phone}@s.whatsapp.net`);
  }
}

async function resolvePeerIdentity(sessionId, slot, peerJid, contact) {
  let phone = resolveJidPhone(sessionId, peerJid, contact);
  const aliases = expandChatJids(sessionId, peerJid);
  aliases.add(peerJid);
  if (contact?.jid) aliases.add(contact.jid);
  if (contact?.lid) aliases.add(contact.lid);
  if (phone) {
    aliases.add(phone);
    aliases.add(`${phone}@s.whatsapp.net`);
    try {
      const results = await slot.client.profile.getLidsByPhoneNumbers([phone]);
      const r = results?.[0];
      if (r?.lidJid) {
        aliases.add(r.lidJid);
        rememberLidPhone(sessionId, r.lidJid, phone);
        linkJidAliases(sessionId, r.lidJid, `${phone}@s.whatsapp.net`);
      }
      if (r?.phoneJid) aliases.add(r.phoneJid);
    } catch (err) {
      console.warn("resolvePeerIdentity lid", err?.message || err);
    }
  } else if (String(peerJid).includes("@lid")) {
    const mapped = lidMapFor(sessionId).get(peerJid) || phoneByJid.get(peerJid) || "";
    if (mapped.length >= 10) {
      phone = mapped;
      aliases.add(phone);
      aliases.add(`${phone}@s.whatsapp.net`);
    }
  }
  for (const a of [...aliases]) {
    for (const x of expandChatJids(sessionId, a)) aliases.add(x);
  }
  return { phone, aliases };
}

async function enrichGroupsParticipants(sessionId, slot, groups, { limit = 120, concurrency = 4 } = {}) {
  const list = groups || [];
  const byJid = new Map(list.filter((g) => g?.jid).map((g) => [g.jid, g]));
  const targets = list
    .filter((g) => g?.jid && !(Array.isArray(g.participants) && g.participants.length))
    .slice(0, limit);
  for (const g of list) {
    if (Array.isArray(g.participants) && g.participants.length) {
      indexGroupParticipants(sessionId, g.participants);
    }
  }
  let cursor = 0;
  let rateHit = false;
  const rateLimited = (err) => {
    const msg = String(err?.message || err || "");
    return msg.includes("429") || msg.includes("rate-overlimit") || msg.includes("rate limit");
  };
  async function enrichOne(g) {
    if (rateHit) return;
    try {
      const meta = await slot.client.group.queryGroupMetadata(g.jid);
      const subject = pickGroupSubject(meta?.subject, g.subject);
      const enriched = {
        ...g,
        ...meta,
        jid: meta?.jid || g.jid,
        subject: subject || g.subject || "",
        participants: meta?.participants || [],
      };
      if (subject) await applyGroupSubject(sessionId, enriched.jid, subject);
      indexGroupParticipants(sessionId, enriched.participants);
      byJid.set(g.jid, enriched);
    } catch (err) {
      if (rateLimited(err)) {
        rateHit = true;
        console.warn("enrichGroupsParticipants rate limited at", g.jid);
        return;
      }
      console.warn("enrichGroupsParticipants", g.jid, err?.message || err);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, targets.length || 0) }, async () => {
    while (cursor < targets.length && !rateHit) {
      const g = targets[cursor++];
      await enrichOne(g);
    }
  });
  await Promise.all(workers);
  const merged = list.map((g) => byJid.get(g.jid) || g);
  const hit = groupsCache.get(sessionId) || {};
  groupsCache.set(sessionId, {
    ...hit,
    ts: Date.now(),
    groups: merged,
    refreshing: false,
    backoffUntil: rateHit ? Date.now() + 600_000 : hit.backoffUntil || 0,
  });
  return merged;
}

function participantPeerKeys(sessionId, p) {
  const keys = new Set();
  const map = lidMapFor(sessionId);
  for (const raw of [p?.jid, p?.lid, p?.phoneNumber]) {
    const s = String(raw || "").trim();
    if (!s) continue;
    keys.add(s);
    const ph = phoneFromJid(s) || s.replace(/\D/g, "");
    if (ph.length >= 10) {
      keys.add(ph);
      keys.add(`${ph}@s.whatsapp.net`);
    }
    const mapped = map.get(s);
    if (mapped && mapped.length >= 10) {
      keys.add(mapped);
      keys.add(`${mapped}@s.whatsapp.net`);
    }
  }
  return keys;
}

function participantMatchesPeer(sessionId, p, peerAliases, phone) {
  const keys = participantPeerKeys(sessionId, p);
  for (const k of keys) {
    if (peerAliases.has(k)) return true;
  }
  if (!phone) return false;
  for (const k of keys) {
    const digits = phoneFromJid(k) || String(k).replace(/\D/g, "");
    if (digits.length >= 10 && digits === phone) return true;
    const mapped = lidMapFor(sessionId).get(k);
    if (mapped === phone) return true;
  }
  return false;
}

async function fetchPeerInfo(sessionId, peerJid, { refreshGroups = false } = {}) {
  const slot = await ensureConnected(sessionId);
  await hydrateSessionIdentityMaps(sessionId, { force: true });
  const contact = await lookupContact(sessionId, peerJid);
  const { phone, aliases } = await resolvePeerIdentity(sessionId, slot, peerJid, contact);
  const phoneDisplay = formatPhoneDisplay(phone);
  const contactName = String(contact?.displayName || "").trim();
  const pushName = String(contact?.pushName || "").trim();
  const commonGroups = [];
  let groupsListed = 0;
  let groupsWithParticipants = 0;
  let groupsRateLimited = false;
  try {
    let groups = await listGroupsCached(sessionId, slot, { force: refreshGroups });
    if (!groups?.length) {
      groups = mergeGroupLists(await listKnownGroupsLocal(sessionId, slot));
    }
    groupsListed = (groups || []).length;
    const cacheHit = groupsCache.get(sessionId);
    groupsRateLimited = !!(cacheHit?.backoffUntil && Date.now() < cacheHit.backoffUntil);
    const needsParticipants = (groups || []).some((g) => !(g.participants?.length));
    if (groupsListed && (needsParticipants || refreshGroups)) {
      groups = await enrichGroupsParticipants(sessionId, slot, groups, {
        limit: groupsRateLimited ? 40 : refreshGroups ? 120 : 80,
        concurrency: groupsRateLimited ? 2 : 4,
      });
      for (const a of [...aliases]) {
        for (const x of expandChatJids(sessionId, a)) aliases.add(x);
      }
    }
    groupsWithParticipants = (groups || []).filter((g) => g.participants?.length).length;
    for (const g of groups || []) {
      if (!g?.jid || isNoiseJid(g.jid)) continue;
      const parts = g.participants || [];
      const hit = parts.some((p) => participantMatchesPeer(sessionId, p, aliases, phone));
      if (hit) {
        commonGroups.push({
          jid: g.jid,
          subject: g.subject || g.jid.split("@")[0],
          size: g.size || parts.length || 0,
        });
      }
    }
  } catch (err) {
    console.warn("fetchPeerInfo groups", err?.message || err);
  }
  return {
    ok: true,
    jid: peerJid,
    contactName,
    pushName,
    name: contactName || pushName || phoneDisplay || peerJid,
    phone: phone || "",
    phoneDisplay: phoneDisplay || "",
    commonGroups: commonGroups.slice(0, 40),
    groupsListed,
    groupsWithParticipants,
    groupsRateLimited,
    groupsRefreshed: !!refreshGroups,
  };
}

async function fetchGroupMembers(sessionId, groupJid) {
  const slot = await ensureConnected(sessionId);
  await hydrateSessionIdentityMaps(sessionId, { force: true });
  let meta;
  try {
    meta = await slot.client.group.queryGroupMetadata(groupJid);
  } catch (err) {
    const msg = String(err?.message || err || "");
    const forbidden = /\b403\b/i.test(msg) || /forbidden/i.test(msg) || /not.?authorized/i.test(msg);
    if (!forbidden) throw err;
    let subject = "";
    try {
      await ensureShared();
      const thread = await sharedStore.session(sessionId).threads.getByJid(groupJid);
      subject = pickGroupSubject(thread?.name, panelChatsFor(sessionId).get(groupJid)?.name);
    } catch {
      subject = pickGroupSubject(panelChatsFor(sessionId).get(groupJid)?.name);
    }
    return {
      ok: true,
      orphan: true,
      forbidden: true,
      jid: groupJid,
      subject: subject || "",
      desc: "",
      size: 0,
      members: [],
      meIsAdmin: false,
      error: msg.slice(0, 200),
    };
  }
  const meJid = String(slot.meJid || "").trim();
  const mePhone = phoneFromJid(meJid);
  const meAliases = new Set(
    [...expandChatJids(sessionId, meJid), meJid, mePhone ? `${mePhone}@s.whatsapp.net` : ""]
      .map((x) => String(x || "").trim())
      .filter(Boolean)
  );
  const members = [];
  let meIsAdmin = false;
  let meIsSuperAdmin = false;
  for (const p of meta.participants || []) {
    const phone = String(p.phoneNumber || "").replace(/\D/g, "") || phoneFromJid(p.jid);
    if (phone && (p.lid || String(p.jid).includes("@lid"))) {
      rememberLidPhone(sessionId, p.lid || p.jid, phone);
    }
    const contact =
      (await lookupContact(sessionId, p.lid || p.jid)) ||
      (p.jid ? await lookupContact(sessionId, p.jid) : null);
    const contactName = String(contact?.displayName || p.displayName || "").trim();
    const pushName = String(contact?.pushName || p.username || "").trim();
    const phoneDisplay = formatPhoneDisplay(phone);
    const name = contactName || pushName || phoneDisplay || phone || p.jid;
    const isMe =
      meAliases.has(String(p.jid || "")) ||
      meAliases.has(String(p.lid || "")) ||
      (phone && mePhone && phone === mePhone);
    if (isMe) {
      meIsAdmin = !!(p.isAdmin || p.isSuperAdmin);
      meIsSuperAdmin = !!p.isSuperAdmin;
    }
    members.push({
      jid: p.jid,
      lid: p.lid || "",
      phone: phone || "",
      phoneDisplay,
      contactName: contactName || "",
      pushName: pushName && pushName !== contactName ? pushName : pushName || "",
      name,
      role: p.isSuperAdmin ? "superadmin" : p.isAdmin ? "admin" : "membro",
      isAdmin: !!p.isAdmin,
      isSuperAdmin: !!p.isSuperAdmin,
      isMe: !!isMe,
      avatarUrl: `avatar?jid=${encodeURIComponent(p.lid || p.jid)}`,
    });
  }
  if (pickGroupSubject(meta.subject)) {
    await applyGroupSubject(sessionId, meta.jid || groupJid, meta.subject);
  }
  return {
    ok: true,
    orphan: false,
    jid: meta.jid || groupJid,
    subject: pickGroupSubject(meta.subject) || "",
    desc: String(meta.desc || meta.description || "").trim(),
    descId: String(meta.descId || meta.descriptionId || "").trim(),
    size: meta.size || members.length,
    owner: meta.owner || meta.ownerJid || "",
    creation: meta.creation || meta.creationTime || null,
    announce: !!(meta.announce ?? meta.announcement),
    restrict: !!meta.restrict,
    ephemeral: Number(meta.ephemeral || meta.ephemeralDuration || 0) || 0,
    memberAddMode: meta.memberAddMode || meta.member_add_mode || "",
    memberLinkMode: meta.memberLinkMode || meta.member_link_mode || "",
    memberShareGroupHistoryMode:
      meta.memberShareGroupHistoryMode || meta.member_share_group_history_mode || "",
    groupHistory: !!(meta.groupHistory ?? meta.group_history),
    allowAdminReports: !!(meta.allowAdminReports ?? meta.allow_admin_reports),
    noFrequentlyForwarded: !!(meta.noFrequentlyForwarded ?? meta.no_frequently_forwarded),
    meIsAdmin,
    meIsSuperAdmin,
    members,
  };
}

async function clearSessionChats(sessionId) {
  let slot;
  try {
    slot = await getOrCreateSession(sessionId);
  } catch {
    slot = null;
  }
  const bundle = sharedStore.session(sessionId);
  if (slot) slot.msgCache.clear();
  panelChatsFor(sessionId).clear();
  statusMaps.delete(sessionId);
  panelOnlyLists.set(sessionId, true);
  try {
    await bundle.messages.clear();
    await bundle.threads.clear();
  } catch (err) {
    console.warn("clearSessionChats store", err?.message || err);
  }
  if (pgBackend?.pool) {
    try {
      await pgBackend.pool.query(
        `DELETE FROM "${ZAPO_TABLE_PREFIX}message_threads" WHERE session_id = $1`,
        [sessionId]
      );
      await pgBackend.pool.query(
        `DELETE FROM "${ZAPO_TABLE_PREFIX}mailbox_messages" WHERE session_id = $1`,
        [sessionId]
      );
    } catch (err) {
      console.warn("clearSessionChats pg", err?.message || err);
    }
  }
  invalidateChatsCache(sessionId);
  groupsCache.delete(sessionId);
  return { ok: true, panelOnly: true };
}

async function proxyAvatar(sessionId, jid, res) {
  const key = String(jid || "");
  if (!key) return json(res, 400, { error: "jid obrigatório" });
  let cache = avatarCache.get(sessionId);
  if (!cache) {
    cache = new Map();
    avatarCache.set(sessionId, cache);
  }
  const normalized = normalizeUserJid(key) || key;
  const hitKey = [key, normalized].find((j) => {
    const hit = cache.get(j);
    return hit && Date.now() - hit.ts < 10 * 60_000 && hit.buf;
  });
  if (hitKey) {
    const hit = cache.get(hitKey);
    res.writeHead(200, {
      "Content-Type": hit.ctype || "image/jpeg",
      "Cache-Control": "private, max-age=300",
    });
    res.end(hit.buf);
    return;
  }
  const slot = await ensureConnected(sessionId);
  await syncSlotIdentity(slot);
  const selfNorm = normalizeUserJid(slot.meJid || "");
  const isSelf =
    !!selfNorm &&
    (normalized === selfNorm ||
      key === slot.meJid ||
      phoneFromJid(normalized) === phoneFromJid(selfNorm));
  const tryList = isSelf
    ? ownJidCandidates(sessionId, slot.meJid || key)
    : [...new Set([normalized, key].filter(Boolean))];
  const av = await fetchOwnAvatarBytes(slot, sessionId, tryList, { force: false });
  if (!av?.buf) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "sem foto" }));
    return;
  }
  res.writeHead(200, {
    "Content-Type": av.ctype || "image/jpeg",
    "Cache-Control": "private, max-age=300",
  });
  res.end(av.buf);
}

async function sendUserMessage(sessionId, body) {
  const slot = await ensureConnected(sessionId);
  if (slot.status !== "open") throw new Error("WhatsApp não está conectado");
  const jid = String(body.jid || body.chatJid || "").trim();
  if (!jid) throw new Error("jid obrigatório");

  if (body.type === "reaction" || body.emoji != null) {
    const target = body.target || {};
    const emoji = String(body.emoji ?? "");
    const targetId = String(target.id || body.messageId || "");
    const preferred = preferChatJid(sessionId, jid, "");
    const result = await slot.client.message.send(jid, {
      type: "reaction",
      emoji,
      target: {
        remoteJid: target.remoteJid || jid,
        id: targetId,
        fromMe: !!target.fromMe,
        participant: target.participant || undefined,
      },
    });
    const reactionMsg = {
      id: result?.id || `react-${Date.now()}`,
      chatJid: preferred || jid,
      fromMe: true,
      type: "reaction",
      text: emoji,
      reaction: {
        text: emoji,
        targetId,
        targetFromMe: !!target.fromMe,
        targetParticipant: String(target.participant || ""),
        targetRemoteJid: String(target.remoteJid || jid),
      },
      timestampMs: Date.now(),
      timestampSeconds: Math.floor(Date.now() / 1000),
      ackStatus: "sent",
    };
    await ensureReactionTargetMessage(sessionId, reactionMsg);
    const bytes = encodeOutboundReactionBytes(emoji, {
      remoteJid: target.remoteJid || jid,
      id: targetId,
      fromMe: !!target.fromMe,
      participant: target.participant,
    });
    await persistStoredMessage(sessionId, reactionMsg, bytes);
    const reactionPayload = {
      id: reactionMsg.id,
      chatJid: reactionMsg.chatJid,
      targetId,
      emoji,
      fromMe: true,
      participant: "",
      pushName: slot.pushName || "",
      timestampMs: reactionMsg.timestampMs,
      timestampSeconds: reactionMsg.timestampSeconds,
    };
    broadcast(slot, "reaction", reactionPayload);
    invalidateChatsCache(sessionId);
    return {
      ok: true,
      message: {
        ...reactionPayload,
        type: "reaction",
        text: emoji,
        reaction: reactionMsg.reaction,
      },
    };
  }

  if (body.type === "buttons" || body.buttonsMessage) {
    const bm = body.buttonsMessage || {
      contentText: String(body.text || body.contentText || ""),
      footerText: String(body.footerText || ""),
      headerType: proto.Message.ButtonsMessage.HeaderType.TEXT,
      text: String(body.headerText || body.title || ""),
      buttons: (body.buttons || []).slice(0, 3).map((b, i) => ({
        buttonId: String(b.id || b.buttonId || `btn-${i + 1}`),
        buttonText: { displayText: String(b.text || b.displayText || `Opção ${i + 1}`) },
        type: proto.Message.ButtonsMessage.Button.Type.RESPONSE,
      })),
    };
    const result = await slot.client.message.send(jid, { buttonsMessage: bm });
    const message = {
      id: result?.id || `local-${Date.now()}`,
      chatJid: jid,
      fromMe: true,
      type: "button",
      text: bm.contentText || bm.text || "",
      timestampMs: Date.now(),
      timestampSeconds: Math.floor(Date.now() / 1000),
      ackStatus: "sent",
    };
    cacheMessage(slot, message, sessionId, []);
    await persistOutboundMessage(sessionId, message, encodeOutboundMessageBytes(message.text, "text"));
    broadcast(slot, "message", message);
    invalidateChatsCache(sessionId);
    return { ok: true, result: result || null, message };
  }

  if (body.type === "list" || body.listMessage) {
    const lm = body.listMessage || {
      title: String(body.title || "Menu"),
      description: String(body.description || body.text || ""),
      buttonText: String(body.buttonText || "Ver opções"),
      footerText: String(body.footerText || ""),
      listType: proto.Message.ListMessage.ListType.SINGLE_SELECT,
      sections: (body.sections || []).map((sec) => ({
        title: String(sec.title || ""),
        rows: (sec.rows || []).map((r, i) => ({
          rowId: String(r.rowId || r.id || `row-${i + 1}`),
          title: String(r.title || `Item ${i + 1}`),
          description: String(r.description || ""),
        })),
      })),
    };
    const result = await slot.client.message.send(jid, { listMessage: lm });
    const message = {
      id: result?.id || `local-${Date.now()}`,
      chatJid: jid,
      fromMe: true,
      type: "list",
      text: lm.description || lm.title || "",
      timestampMs: Date.now(),
      timestampSeconds: Math.floor(Date.now() / 1000),
      ackStatus: "sent",
    };
    cacheMessage(slot, message, sessionId, []);
    await persistOutboundMessage(sessionId, message, encodeOutboundMessageBytes(message.text, "text"));
    broadcast(slot, "message", message);
    invalidateChatsCache(sessionId);
    return { ok: true, result: result || null, message };
  }

  let tempFiles = [];
  try {
    let content = body.content;
    if (content == null) {
      if (body.text != null) {
        const text = String(body.text);
        const wantPreview =
          body.linkPreview !== false && body.linkPreview !== "false" && /https?:\/\//i.test(text);
        content = wantPreview
          ? { type: "text", text, linkPreview: true }
          : text;
      } else if (body.type && (body.mediaBase64 || body.files?.media || body.mediaPath)) {
        content = {
          type: body.type,
          mimetype: body.mimetype || body.fields?.mimetype || "application/octet-stream",
          caption: body.caption || body.fields?.caption || "",
          fileName: body.fileName || body.fields?.fileName || undefined,
        };
        if (body.ptt === true || body.ptt === "true" || body.fields?.ptt === "true") {
          content.ptt = true;
        }
        if (content.type === "audio" && content.ptt) {
          content.fileName = "voice.ogg";
          if (!content.mimetype || content.mimetype.includes("webm")) {
            content.mimetype = "audio/ogg; codecs=opus";
          }
        }
        if (body.mediaPath) {
          content.media = body.mediaPath;
        } else if (body.files?.media?.buffer) {
          const dest = path.join(
            os.tmpdir(),
            `sf-wa-up-${Date.now()}-${Math.random().toString(36).slice(2)}`
          );
          fs.writeFileSync(dest, body.files.media.buffer);
          tempFiles.push(dest);
          content.media = dest;
          const uploadedMime = body.files.media.mimetype || content.mimetype;
          // PTT: keep opus/ogg label; normalizeVoiceNote (ffmpeg) re-encodes webm→ogg
          if (content.type === "audio" && content.ptt) {
            content.mimetype =
              !uploadedMime || String(uploadedMime).includes("webm")
                ? "audio/ogg; codecs=opus"
                : uploadedMime;
            content.fileName = "voice.ogg";
          } else {
            content.mimetype = uploadedMime;
            content.fileName = body.files.media.filename || content.fileName;
          }
        } else if (body.mediaBase64) {
          const dest = path.join(
            os.tmpdir(),
            `sf-wa-up-${Date.now()}-${Math.random().toString(36).slice(2)}`
          );
          fs.writeFileSync(dest, Buffer.from(body.mediaBase64, "base64"));
          tempFiles.push(dest);
          content.media = dest;
        } else {
          throw new Error("Arquivo de mídia ausente");
        }
      } else {
        throw new Error("content ou text obrigatório");
      }
    }

    const options = {
      ackTimeoutMs: 25_000,
      maxAttempts: 2,
      ...(body.options || {}),
    };
    const result = await slot.client.message.send(jid, content, options);
    const text =
      typeof content === "string"
        ? content
        : content?.caption || body.text || body.caption || "";
    const type =
      typeof content === "string" ? "text" : content?.type || body.type || "text";
    const preferred = preferChatJid(sessionId, jid, "");
    const message = {
      id: result?.id || `local-${Date.now()}`,
      chatJid: preferred || jid,
      chatJidAlt: preferred && preferred !== jid ? jid : "",
      fromMe: true,
      fromPhone: false,
      participant: "",
      isGroup: isGroupJid(jid),
      pushName: slot.pushName || "",
      timestampMs: Date.now(),
      timestampSeconds: Math.floor(Date.now() / 1000),
      type,
      text: String(text || ""),
      ackStatus: "sent",
      isStatus: false,
      hasMedia: ["image", "video", "audio", "document", "sticker"].includes(type),
      mimetype: content?.mimetype || body.mimetype || "",
      fileName: content?.fileName || body.fileName || "",
    };
    linkJidAliases(sessionId, jid, preferred);
    cacheMessage(slot, message, sessionId, [jid, preferred, message.chatJidAlt]);
    await persistStoredMessage(
      sessionId,
      message,
      encodeOutboundMessageBytesFromContent(content, text, type)
    );
    await ensureThreadRecord(sessionId, preferred || jid, "");
    rememberPanelChat(sessionId, {
      jid: preferred || jid,
      isGroup: isGroupJid(jid),
      openedAt: Date.now(),
      fromMe: true,
    });
    broadcast(slot, "message", message);
    invalidateChatsCache(sessionId);
    return { ok: true, result: result || null, message };

  } finally {
    for (const f of tempFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
}

async function downloadMedia(sessionId, messageId, chatJid, res) {
  let slot;
  try {
    slot = await ensureConnected(sessionId);
  } catch {
    slot = await getOrCreateSession(sessionId);
  }
  const live = mediaMapFor(sessionId).get(String(messageId || ""));
  /** @type {any} */
  let protoMsg = null;
  /** @type {any} */
  let eventLike = null;
  let mime = "application/octet-stream";

  if (live?.message) {
    protoMsg = live.message;
    eventLike = { key: live.key, message: live.message };
    mime = live.mimetype || mime;
  } else {
    await hydrateSessionIdentityMaps(sessionId);
    const bundle = sharedStore.session(sessionId);
    const record = await bundle.messages.getById(messageId);
    if (!record) {
      return json(res, 404, {
        error: "mídia não encontrada no cache nem no banco — abra o chat com a sessão conectada e aguarde a mensagem chegar de novo",
      });
    }
    const jids = expandChatJids(sessionId, chatJid || record.threadJid);
    jids.add(record.threadJid);
    if (chatJid) jids.add(chatJid);
    if (chatJid && record.threadJid !== chatJid && !jids.has(record.threadJid) && !jids.has(chatJid)) {
      // still allow by message id — identity maps may be incomplete
    }
    const decoded = decodeStoredMessage(record);
    if (!decoded._message || !decoded.hasMedia) {
      return json(res, 400, { error: "mensagem no banco sem payload de mídia baixável" });
    }
    protoMsg = decoded._message;
    eventLike = {
      key: {
        remoteJid: record.threadJid,
        id: record.id,
        fromMe: record.fromMe,
        participant: record.participantJid,
      },
      message: decoded._message,
    };
    mime = decoded.mimetype || mime;
  }

  const tryDownload = async (source) => {
    const bytes = await slot.client.message.downloadBytes(source, { maxBytes: 40 * 1024 * 1024 });
    return Buffer.from(bytes);
  };

  try {
    let buf;
    try {
      // zapo aceita Proto.IMessage ou evento com .message
      buf = await tryDownload(protoMsg);
    } catch (errProto) {
      if (!eventLike) throw errProto;
      try {
        buf = await tryDownload(eventLike);
      } catch {
        const stream = await slot.client.message.download(eventLike);
        if (stream && typeof stream.pipe === "function") {
          res.writeHead(200, {
            "Content-Type": mime,
            "Cache-Control": "no-store",
          });
          stream.on("error", () => {
            try {
              res.end();
            } catch {
              /* ignore */
            }
          });
          stream.pipe(res);
          return;
        }
        throw errProto;
      }
    }
    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": "no-store",
      "Content-Length": String(buf.length),
    });
    res.end(buf);
  } catch (err) {
    console.warn("downloadMedia", messageId, err?.message || err);
    return json(res, 502, { error: String(err?.message || err) });
  }
}

async function invokeCoordinator(sessionId, coordinator, method, args) {
  const slot = await ensureConnected(sessionId);
  const coord = slot.client[coordinator];
  if (!coord || typeof coord[method] !== "function") {
    throw new Error(`Método inválido: ${coordinator}.${method}`);
  }
  const result = await coord[method](...(args || []));
  return result === undefined ? { ok: true } : result;
}

async function publishOwnStatus(sessionId, body) {
  const slot = await ensureConnected(sessionId);
  if (slot.status !== "open") throw new Error("WhatsApp não está conectado");
  const text = String(body.text || body.content || "").trim();
  const type = String(body.type || "text");
  let content = text;
  if (type !== "text" && (body.mediaPath || body.mediaBase64 || body.files?.media)) {
    content = {
      type,
      mimetype: body.mimetype || "application/octet-stream",
      caption: text,
    };
    // media handled similarly if needed — text status first
  }
  if (!text && type === "text") throw new Error("Texto do status obrigatório");

  let recipients = Array.isArray(body.recipients) ? body.recipients.filter(Boolean) : [];
  if (!recipients.length) {
    const contacts = await listContacts(sessionId);
    recipients = contacts
      .map((c) => c.lid || c.jid)
      .filter((j) => j && !isGroupJid(j) && !isNoiseJid(j));
    if (!recipients.length) {
      const threads = await listThreads(sessionId);
      recipients = threads
        .filter((t) => !t.isGroup)
        .map((t) => t.jid)
        .filter((j) => j && !isNoiseJid(j));
    }
  }
  recipients = [...new Set(recipients)].slice(0, 256);
  if (!recipients.length) {
    throw new Error("Nenhum destinatário disponível para o status (conecte contatos ou tenha conversas).");
  }

  const result = await slot.client.status.send({
    content: typeof content === "string" ? content : content,
    recipients,
  });
  const serialized = {
    id: result?.id || `status-${Date.now()}`,
    chatJid: "status@broadcast",
    chatJidAlt: "",
    fromMe: true,
    participant: "",
    isGroup: false,
    pushName: slot.pushName || "Meu status",
    timestampMs: Date.now(),
      timestampSeconds: Math.floor(Date.now() / 1000),
    type: "text",
    text,
    ackStatus: "sent",
    isStatus: true,
    hasMedia: false,
    mimetype: "",
    fileName: "",
  };
  const feed = rememberStatusItem(sessionId, serialized, {
    recipients: recipients.length,
    views: 0,
    viewers: [],
  });
  broadcast(slot, "status", { feed, item: serialized });
  return {
    ok: true,
    message: serialized,
    recipients: recipients.length,
    feed,
  };
}

function parseSessionPath(pathname) {
  // /sessions/:id/...
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "sessions" || !parts[1]) return null;
  return { sessionId: decodeURIComponent(parts[1]), rest: parts.slice(2) };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  try {
    // Legado admin
    if (req.method === "GET" && url.pathname === "/status") {
      const slot = sessions.get(ADMIN_SESSION);
      const body = publicStatus(slot, ADMIN_SESSION);
      body.inbound = true;
      body.inboundVersion = INBOUND_VERSION;
      body.multiSession = true;
      return json(res, 200, body);
    }
    if (req.method === "POST" && url.pathname === "/pair") {
      const slot = await ensureConnected(ADMIN_SESSION, { history: false });
      return json(res, 200, {
        ok: true,
        status: slot.status,
        qrPng: slot.qrPng,
        qr: slot.qr,
      });
    }
    if (req.method === "POST" && url.pathname === "/logout") {
      const slot = sessions.get(ADMIN_SESSION);
      if (slot?.client) {
        try {
          await slot.client.logout();
        } catch {
          try {
            await slot.client.disconnect();
          } catch {
            /* ignore */
          }
        }
      }
      sessions.delete(ADMIN_SESSION);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/send") {
      const body = await readBody(req);
      await adminSend(body);
      return json(res, 200, { ok: true });
    }

    const parsed = parseSessionPath(url.pathname);
    if (!parsed) {
      return json(res, 404, { error: "not_found" });
    }
    if (!requireSecret(req) && parsed.sessionId !== ADMIN_SESSION) {
      // still allow if no secret configured
    }
    if (GATEWAY_SECRET && !requireSecret(req)) {
      return json(res, 401, { error: "unauthorized" });
    }

    const { sessionId, rest } = parsed;
    const action = rest[0] || "";

    if (req.method === "GET" && action === "status") {
      let slot = sessions.get(sessionId);
      if (!slot) slot = await getOrCreateSession(sessionId);
      return json(res, 200, publicStatus(slot, sessionId));
    }
    if (req.method === "POST" && action === "connect") {
      const slot = await ensureConnected(sessionId);
      return json(res, 200, publicStatus(slot, sessionId));
    }
    if (req.method === "POST" && action === "pair") {
      // Zapo: connect() bloqueia até o pairing terminar — não awaitar.
      // Dispara connect em background e devolve assim que houver QR (ou open).
      const slot = await getOrCreateSession(sessionId);
      if (slot.status === "open") {
        return json(res, 200, { ok: true, ...publicStatus(slot, sessionId) });
      }
      if (!slot.connecting) {
        void ensureConnected(sessionId).catch((err) => {
          const s = sessions.get(sessionId);
          if (!s) return;
          s.error = String(err?.message || err);
          s.connecting = false;
          if (s.status !== "open" && s.status !== "qr") s.status = "error";
          broadcast(s, "connection", { status: s.status, error: s.error });
        });
      }
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (slot.qrPng || slot.status === "open" || (slot.error && slot.status === "error")) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      return json(res, 200, {
        ok: true,
        ...publicStatus(slot, sessionId),
      });
    }
    if (req.method === "POST" && action === "logout") {
      const slot = sessions.get(sessionId) || (await getOrCreateSession(sessionId));
      try {
        await clearSessionChats(sessionId);
      } catch (err) {
        console.warn("logout clear chats", err?.message || err);
      }
      try {
        await slot.client.logout();
      } catch {
        try {
          await slot.client.disconnect();
        } catch {
          /* ignore */
        }
      }
      try {
        const bundle = sharedStore?.session(sessionId);
        if (bundle?.destroy) await bundle.destroy();
      } catch {
        /* ignore */
      }
      sessions.delete(sessionId);
      panelChatsFor(sessionId).clear();
      statusMaps.delete(sessionId);
      panelOnlyLists.delete(sessionId);
      lidPhoneMaps.delete(sessionId);
      avatarCache.delete(sessionId);
      mediaPayloadMaps.delete(sessionId);
      jidAliasMaps.delete(sessionId);
      identityHydratedAt.delete(sessionId);
      openChatViews.delete(sessionId);
      chatsCache.delete(sessionId);
      groupsCache.delete(sessionId);
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && action === "chats") {
      if (!sessions.has(sessionId) || sessions.get(sessionId).status !== "open") {
        await ensureConnected(sessionId).catch(() => null);
      }
      const force = url.searchParams.get("refresh") === "1";
      if (force) {
        const slot = sessions.get(sessionId);
        if (slot?.status === "open") {
          try {
            await listGroupsCached(sessionId, slot, { force: true });
          } catch (err) {
            console.warn("chats refresh groups", err?.message || err);
          }
        }
      }
      const chats = await listThreadsCached(sessionId, { force });
      return json(res, 200, { ok: true, chats, cached: !force });
    }
    if (req.method === "GET" && action === "messages") {
      const chatJid = url.searchParams.get("chatJid") || "";
      const limit = Number(url.searchParams.get("limit") || 80);
      const before = url.searchParams.get("beforeMs");
      if (!chatJid) return json(res, 400, { error: "chatJid obrigatório" });
      const messages = await listMessages(
        sessionId,
        chatJid,
        limit,
        before ? Number(before) : undefined
      );
      return json(res, 200, { ok: true, messages: publicMessages(messages) });
    }
    if (req.method === "POST" && action === "send") {
      const body = await readBody(req);
      // merge multipart fields
      if (body.fields) {
        Object.assign(body, body.fields);
        if (body.jid == null && body.chatJid) body.jid = body.chatJid;
      }
      const result = await sendUserMessage(sessionId, body);
      return json(res, 200, result);
    }
    if (req.method === "GET" && action === "media") {
      const messageId = url.searchParams.get("messageId") || "";
      const chatJid = url.searchParams.get("chatJid") || "";
      if (!messageId) return json(res, 400, { error: "messageId obrigatório" });
      return downloadMedia(sessionId, messageId, chatJid, res);
    }
    if (req.method === "GET" && action === "contacts") {
      await getOrCreateSession(sessionId);
      return json(res, 200, { ok: true, contacts: await listContacts(sessionId) });
    }
    if (req.method === "GET" && action === "statuses") {
      await getOrCreateSession(sessionId);
      return json(res, 200, { ok: true, statuses: listStatusesPublic(sessionId) });
    }
    if (req.method === "POST" && action === "statuses") {
      const body = await readBody(req);
      const data = await publishOwnStatus(sessionId, body || {});
      return json(res, 200, data);
    }
    if (req.method === "GET" && action === "profile") {
      const force =
        url.searchParams.get("refresh") === "1" ||
        url.searchParams.get("force") === "1";
      try {
        const data = await resolveOwnProfile(sessionId, { force });
        return json(res, 200, data);
      } catch (err) {
        console.warn("profile", err?.message || err);
        return json(res, 500, { ok: false, error: String(err?.message || err) });
      }
    }
    if (req.method === "GET" && action === "group") {
      const groupJid = url.searchParams.get("jid") || "";
      if (!groupJid) return json(res, 400, { error: "jid obrigatório" });
      const data = await fetchGroupMembers(sessionId, groupJid);
      return json(res, 200, data);
    }
    if (req.method === "GET" && action === "peer") {
      const peerJid = url.searchParams.get("jid") || "";
      if (!peerJid) return json(res, 400, { error: "jid obrigatório" });
      const refreshGroups = url.searchParams.get("refresh") === "1";
      const data = await fetchPeerInfo(sessionId, peerJid, { refreshGroups });
      return json(res, 200, data);
    }
    if (req.method === "POST" && action === "refresh-groups") {
      const slot = await ensureConnected(sessionId);
      invalidateChatsCache(sessionId);
      const groups = await listGroupsCached(sessionId, slot, { force: true });
      const enriched = groups?.length
        ? await enrichGroupsParticipants(sessionId, slot, groups, { limit: 200 })
        : [];
      for (const g of enriched || []) {
        if (g?.jid && g.subject) await applyGroupSubject(sessionId, g.jid, g.subject);
      }
      invalidateChatsCache(sessionId);
      return json(res, 200, {
        ok: true,
        count: enriched.length,
        groups: enriched.map((g) => ({
          jid: g.jid,
          subject: pickGroupSubject(g.subject, g.name) || "",
          size: g.size || g.participants?.length || 0,
        })),
      });
    }
    if (req.method === "GET" && action === "avatar") {
      const jid = url.searchParams.get("jid") || "";
      return proxyAvatar(sessionId, jid, res);
    }
    if (req.method === "POST" && action === "resolve-phone") {
      const body = await readBody(req);
      const data = await resolvePhoneNumber(sessionId, body.phone || body.number || "");
      return json(res, 200, data);
    }
    if (req.method === "POST" && action === "start-chat") {
      const body = await readBody(req);
      let data;
      if (body.jid && !body.phone && !body.number) {
        const jid = String(body.jid).trim();
        const name = String(body.name || "").trim();
        await ensureThreadRecord(sessionId, jid, name);
        rememberPanelChat(sessionId, {
          jid,
          name,
          phone: String(body.phone || "").replace(/\D/g, ""),
          phoneDisplay: formatPhoneDisplay(body.phone || ""),
          isGroup: isGroupJid(jid),
          openedAt: Date.now(),
        });
        data = {
          ok: true,
          jid,
          phone: String(body.phone || "").replace(/\D/g, ""),
          phoneDisplay: formatPhoneDisplay(body.phone || "") || name,
        };
      } else {
        data = await resolvePhoneNumber(sessionId, body.phone || body.number || "");
      }
      return json(res, 200, {
        ...data,
        chat: {
          jid: data.jid,
          name: data.phoneDisplay || data.name || data.jid,
          phone: data.phone || "",
          isGroup: isGroupJid(data.jid),
        },
      });
    }
    if (req.method === "POST" && action === "read") {
      const body = await readBody(req);
      const chatJid = String(body.jid || body.chatJid || "").trim();
      if (!chatJid) return json(res, 400, { error: "jid obrigatório" });
      const data = await markSessionChatRead(sessionId, chatJid);
      return json(res, 200, data);
    }
    if (req.method === "POST" && action === "clear-chats") {
      const data = await clearSessionChats(sessionId);
      return json(res, 200, data);
    }
    if (req.method === "POST" && action === "leave-groups") {
      try {
        const body = await readBody(req);
        const data = await applyGroupBulkActions(sessionId, body || {});
        return json(res, 200, data);
      } catch (err) {
        console.warn("leave-groups", err?.message || err);
        return json(res, 500, { ok: false, error: String(err?.message || err) });
      }
    }
    if (req.method === "POST" && action === "history") {
      // Histórico antigo desativado de propósito
      return json(res, 200, { ok: false, disabled: true, error: "sync de mensagens antigas desativado" });
    }
    if (req.method === "POST" && action === "receipt") {
      const body = await readBody(req);
      const slot = await ensureConnected(sessionId);
      const ids = body.ids || [];
      if (Array.isArray(ids) && ids.length) {
        await slot.client.message.sendReceipt(body.target || body.chatJid, ids, {
          type: body.type || "read",
        });
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && action === "presence") {
      const body = await readBody(req);
      const slot = await ensureConnected(sessionId);
      if (body.chatstate) {
        const state =
          typeof body.chatstate === "string"
            ? body.chatstate
            : body.chatstate.state || body.chatstate.type || "composing";
        await slot.client.presence.sendChatstate(body.jid, { state });
      } else if (body.subscribe) {
        await slot.client.presence.subscribe(body.jid);
      } else {
        await slot.client.presence.send(body.status || "available");
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && action === "invoke") {
      const body = await readBody(req);
      const result = await invokeCoordinator(
        sessionId,
        body.coordinator,
        body.method,
        body.args || []
      );
      const method = String(body.method || "");
      if (method === "leaveGroup" || method === "deleteChat" || method === "setSubject" || method === "setDescription") {
        invalidateChatsCache(sessionId);
        if (method === "setSubject") {
          const jid = Array.isArray(body.args) ? body.args[0] : "";
          const subject = Array.isArray(body.args) ? body.args[1] : "";
          if (jid && subject) await applyGroupSubject(sessionId, jid, subject);
        }
        if (method === "leaveGroup" || method === "deleteChat") {
          const jid = Array.isArray(body.args) ? (Array.isArray(body.args[0]) ? body.args[0][0] : body.args[0]) : "";
          if (jid) await purgeLocalGroupChat(sessionId, jid).catch(() => null);
        }
      }
      if (String(body.coordinator || "") === "profile" && method === "setPushName") {
        const slot = sessions.get(sessionId);
        if (slot) slot.pushName = String(Array.isArray(body.args) ? body.args[0] || "" : "").trim();
      }
      return json(res, 200, { ok: true, result });
    }
    if (req.method === "GET" && action === "events") {
      const slot = await getOrCreateSession(sessionId);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ event: "hello", data: publicStatus(slot, sessionId) })}\n\n`);
      slot.eventClients.add(res);
      req.on("close", () => slot.eventClients.delete(res));
      return;
    }

    json(res, 404, { error: "not_found" });
  } catch (err) {
    json(res, 500, { error: String(err?.message || err) });
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const parsed = parseSessionPath(url.pathname);
    if (!parsed || parsed.rest[0] !== "ws") {
      socket.destroy();
      return;
    }
    if (GATEWAY_SECRET) {
      const secret = url.searchParams.get("secret") || "";
      if (secret !== GATEWAY_SECRET) {
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, async (ws) => {
      const slot = await getOrCreateSession(parsed.sessionId);
      slot.wsClients.add(ws);
      ws.send(JSON.stringify({ event: "hello", data: publicStatus(slot, parsed.sessionId) }));
      ws.on("close", () => slot.wsClients.delete(ws));
    });
  } catch {
    socket.destroy();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`zapo gateway http://127.0.0.1:${PORT} (multi-session v${INBOUND_VERSION})`);
  ensureConnected(ADMIN_SESSION, { history: false }).catch((err) => {
    console.error("auto-connect admin", err);
  });
  void resumePairedSessions();
});

/** Reconecta sessões que já têm credenciais salvas no Postgres (após restart). */
async function resumePairedSessions() {
  try {
    await ensureShared();
    if (!pgBackend?.pool) return;
    const { rows } = await pgBackend.pool.query(
      `SELECT session_id, me_jid FROM "${ZAPO_TABLE_PREFIX}auth_credentials"
       WHERE me_jid IS NOT NULL AND TRIM(me_jid) <> ''`
    );
    const ids = (rows || [])
      .map((r) => String(r.session_id || "").trim())
      .filter((id) => id && id !== ADMIN_SESSION);
    console.log(`[wa-gateway] auto-resume ${ids.length} paired session(s)`);
    for (const sid of ids) {
      ensureConnected(sid).catch((err) => {
        console.warn("auto-resume", sid, err?.message || err);
      });
    }
  } catch (err) {
    console.warn("resumePairedSessions", err?.message || err);
  }
}

async function gracefulShutdown(signal) {
  console.log(`gateway ${signal}: flushing sessions…`);
  for (const [id, slot] of sessions.entries()) {
    try {
      if (slot?.client?.disconnect) await slot.client.disconnect();
    } catch (err) {
      console.warn("disconnect", id, err?.message || err);
    }
  }
  try {
    if (sharedStore?.destroy) await sharedStore.destroy();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
