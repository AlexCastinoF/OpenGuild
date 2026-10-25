export type WaSlot = {
  id: number;
  slot: number;
  session_id: string;
  me_jid: string;
  push_name: string;
  status: string;
  qrPng?: string;
  qr?: string;
  error?: string;
  has_crypto: boolean;
  crypto_salt?: string;
  created_at?: number;
  updated_at?: number;
};

export type WaLastMessage = {
  text?: string;
  type?: string;
  timestampSeconds?: number;
  timestampMs?: number;
  fromMe?: boolean;
  id?: string;
};

export type WaChat = {
  jid: string;
  name?: string;
  subject?: string;
  contactName?: string;
  pushName?: string;
  phone?: string;
  phoneDisplay?: string;
  lastMessage?: WaLastMessage | string;
  lastTs?: number;
  timestampSeconds?: number;
  unread?: number;
  unreadCount?: number;
  isGroup?: boolean;
  kind?: string;
  pinned?: number | boolean;
  archived?: boolean;
};

export type WaMessage = {
  id: string;
  chatJid?: string;
  fromMe?: boolean;
  text?: string;
  body?: string;
  caption?: string;
  type?: string;
  ts?: number;
  timestamp?: number;
  timestampSeconds?: number;
  timestampMs?: number;
  pushName?: string;
  mediaType?: string;
  hasMedia?: boolean;
  fileName?: string;
  mimetype?: string;
  ackStatus?: string;
  participant?: string;
  participantAlt?: string;
  fromPhone?: boolean;
  contact?: { displayName?: string; vcard?: string };
  contacts?: Array<{ displayName?: string; vcard?: string }>;
  contactTitle?: string;
  location?: {
    lat?: number;
    lng?: number;
    name?: string;
    address?: string;
    isLive?: boolean;
  };
  poll?: { name?: string; options?: string[] };
  linkPreview?: { url?: string; title?: string; description?: string };
  reaction?: {
    text?: string;
    targetId?: string;
    targetFromMe?: boolean;
    targetParticipant?: string;
    targetRemoteJid?: string;
  };
  /** Reações anexadas a esta mensagem (UI). */
  reactions?: WaReactionChip[];
  groupInvite?: { groupName?: string; inviteCode?: string };
  event?: { name?: string; description?: string; startTime?: number };
  payloadDebug?: string;
};

export type WaReactionChip = {
  emoji: string;
  fromMe?: boolean;
  participant?: string;
  pushName?: string;
};

export type WaStatusFeed = {
  authorKey: string;
  authorJid?: string;
  pushName?: string;
  phoneDisplay?: string;
  phone?: string;
  isMe?: boolean;
  items?: Array<{
    id?: string;
    text?: string;
    type?: string;
    timestampSeconds?: number;
  }>;
};

export type WaTab = 'dm' | 'group' | 'status';
