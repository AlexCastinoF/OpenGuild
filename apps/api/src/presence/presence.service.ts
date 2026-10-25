import { Injectable } from '@nestjs/common';
import { userIdentity } from '@steamfarm/shared';
import { RedisService } from '../redis/redis.service';

export type PresenceMeta = {
  location: string;
  location_source: string;
  ping_ms: number;
  voice_channel_id: number | null;
  name: string;
  avatar_url: string;
  gps_ts?: number;
  ip_location?: string;
  activity?: {
    type: string;
    title?: string;
    url?: string;
    videoId?: string;
    startedAt?: number;
  } | null;
  /** Placar CS2 ao vivo (GSI) — partilhado com a lista de membros. */
  cs2_live?: Cs2LiveShare | null;
};

export type Cs2LiveShare = {
  at: number;
  map: string;
  scoreCt: number;
  scoreT: number;
  team: string;
  kills: number;
  deaths: number;
  health: number;
  /** match = em jogo; lobby = fila/lobby com modo conhecido */
  kind?: 'match' | 'lobby';
  mode?: string;
  modeLabel?: string;
  phase?: string;
};

export type ActiveVoice = {
  serverId: number;
  channelId: number;
  at: number;
};

@Injectable()
export class PresenceService {
  private readonly ttl = 120;

  constructor(private readonly redis: RedisService) {}

  private key(serverId: number, userId: number) {
    return `presence:server:${serverId}:user:${userId}`;
  }

  private activeVoiceKey(userId: number) {
    return `presence:active_voice:user:${userId}`;
  }

  async getActiveVoice(userId: number): Promise<ActiveVoice | null> {
    const raw = await this.redis.get(this.activeVoiceKey(userId));
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as ActiveVoice;
      if (!v?.serverId || !v?.channelId) return null;
      return {
        serverId: Number(v.serverId),
        channelId: Number(v.channelId),
        at: Number(v.at) || 0,
      };
    } catch {
      return null;
    }
  }

  async setActiveVoice(userId: number, serverId: number, channelId: number) {
    const payload: ActiveVoice = {
      serverId,
      channelId,
      at: Date.now() / 1000,
    };
    await this.redis.setex(this.activeVoiceKey(userId), 300, JSON.stringify(payload));
  }

  async clearActiveVoice(userId: number, match?: { serverId: number; channelId?: number }) {
    if (match) {
      const cur = await this.getActiveVoice(userId);
      if (!cur || cur.serverId !== match.serverId) return;
      if (match.channelId != null && cur.channelId !== match.channelId) return;
    }
    await this.redis.del(this.activeVoiceKey(userId));
  }

  /** Remove a chave de presença → some da lista online imediatamente. */
  async clear(serverId: number, userId: number): Promise<void> {
    await this.redis.del(this.key(serverId, userId));
  }

  /** Limpa voice_channel_id em todos os servidores deste usuário (exceto opcional). */
  async clearVoiceEverywhere(userId: number, exceptServerId?: number): Promise<ActiveVoice[]> {
    const keys = await this.redis.keys(`presence:server:*:user:${userId}`);
    const previous: ActiveVoice[] = [];
    for (const k of keys) {
      const parts = k.split(':');
      // presence:server:{id}:user:{uid}
      const serverId = Number(parts[2]);
      if (!Number.isFinite(serverId)) continue;
      if (exceptServerId != null && serverId === exceptServerId) continue;
      const raw = await this.redis.get(k);
      if (!raw) continue;
      try {
        const meta = JSON.parse(raw) as PresenceMeta;
        if (meta.voice_channel_id) {
          previous.push({
            serverId,
            channelId: Number(meta.voice_channel_id),
            at: 0,
          });
          meta.voice_channel_id = null;
          await this.redis.setex(k, this.ttl, JSON.stringify(meta));
        }
      } catch {
        /* ignore */
      }
    }
    return previous;
  }

  async touch(
    serverId: number,
    userId: number,
    meta: Partial<PresenceMeta> = {},
  ): Promise<void> {
    const prevRaw = await this.redis.get(this.key(serverId, userId));
    let prev: Partial<PresenceMeta> = {};
    if (prevRaw) {
      try {
        prev = JSON.parse(prevRaw) as PresenceMeta;
      } catch {
        prev = {};
      }
    }
    const payload: PresenceMeta = {
      location: meta.location ?? prev.location ?? '',
      location_source: meta.location_source ?? prev.location_source ?? '',
      ping_ms: Math.max(
        0,
        Math.min(9999, Number(meta.ping_ms ?? prev.ping_ms) || 0),
      ),
      voice_channel_id:
        meta.voice_channel_id !== undefined
          ? meta.voice_channel_id
          : (prev.voice_channel_id ?? null),
      name: meta.name ?? prev.name ?? '',
      avatar_url: meta.avatar_url ?? prev.avatar_url ?? '',
      gps_ts: meta.gps_ts ?? prev.gps_ts,
      ip_location: meta.ip_location ?? prev.ip_location ?? '',
      activity:
        meta.activity !== undefined ? meta.activity : (prev.activity ?? null),
    };
    // Em voz: TTL maior — aba em segundo plano ainda conta como online
    const ttl = payload.voice_channel_id ? 300 : this.ttl;
    await this.redis.setex(this.key(serverId, userId), ttl, JSON.stringify(payload));
  }

  async setVoiceChannel(serverId: number, userId: number, channelId: number | null) {
    if (channelId == null) {
      await this.touch(serverId, userId, { voice_channel_id: null });
      await this.clearActiveVoice(userId, { serverId });
      return;
    }
    await this.touch(serverId, userId, { voice_channel_id: channelId });
    await this.setActiveVoice(userId, serverId, channelId);
  }

  async setGlobalActivity(
    userId: number,
    activity: PresenceMeta['activity'],
  ): Promise<void> {
    const key = `presence:activity:user:${userId}`;
    if (!activity) {
      await this.redis.del(key);
      return;
    }
    await this.redis.setex(key, 300, JSON.stringify(activity));
  }

  async getGlobalActivity(userId: number): Promise<PresenceMeta['activity']> {
    const raw = await this.redis.get(`presence:activity:user:${userId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PresenceMeta['activity'];
    } catch {
      return null;
    }
  }

  async mergeActivities(
    info: Record<string, PresenceMeta>,
    userIds: number[],
  ): Promise<Record<string, PresenceMeta>> {
    const out = { ...info };
    for (const uid of userIds) {
      const act = await this.getGlobalActivity(uid);
      const cs2 = await this.getCs2Live(uid);
      const key = String(uid);
      if (!out[key]) {
        if (!act && !cs2) continue;
        out[key] = {
          location: '',
          location_source: '',
          ping_ms: 0,
          voice_channel_id: null,
          name: '',
          avatar_url: '',
          activity: act,
          cs2_live: cs2,
        };
      } else {
        out[key] = {
          ...out[key],
          activity: act ?? out[key].activity ?? null,
          cs2_live: cs2 ?? out[key].cs2_live ?? null,
        };
      }
    }
    return out;
  }

  private cs2LiveKey(userId: number) {
    return `presence:cs2_live:user:${userId}`;
  }

  async setCs2Live(userId: number, live: Cs2LiveShare | null): Promise<void> {
    const key = this.cs2LiveKey(userId);
    if (!live) {
      await this.redis.del(key);
      return;
    }
    // TTL curto: se o Desktop parar de enviar, o badge some
    await this.redis.setex(key, 45, JSON.stringify(live));
  }

  async getCs2Live(userId: number): Promise<Cs2LiveShare | null> {
    const raw = await this.redis.get(this.cs2LiveKey(userId));
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as Cs2LiveShare;
      if (!v || !Number(v.at)) return null;
      if (Date.now() - Number(v.at) > 45000) return null;
      const kind = v.kind === 'lobby' ? 'lobby' : 'match';
      return {
        at: Number(v.at) || 0,
        map: String(v.map || 'CS2'),
        scoreCt: Number(v.scoreCt) || 0,
        scoreT: Number(v.scoreT) || 0,
        team: String(v.team || ''),
        kills: Number(v.kills) || 0,
        deaths: Number(v.deaths) || 0,
        health: Number(v.health) || 0,
        kind,
        mode: String(v.mode || ''),
        modeLabel: String(v.modeLabel || ''),
        phase: String(v.phase || ''),
      };
    } catch {
      return null;
    }
  }

  async onlineUserIds(serverId: number): Promise<number[]> {
    const keys = await this.redis.keys(`presence:server:${serverId}:user:*`);
    return keys
      .map((k) => Number(k.split(':').pop()))
      .filter((n) => Number.isFinite(n));
  }

  async presenceInfo(serverId: number): Promise<Record<string, PresenceMeta>> {
    const keys = await this.redis.keys(`presence:server:${serverId}:user:*`);
    const out: Record<string, PresenceMeta> = {};
    for (const k of keys) {
      const uid = k.split(':').pop()!;
      const raw = await this.redis.get(k);
      if (!raw) continue;
      try {
        out[uid] = JSON.parse(raw) as PresenceMeta;
      } catch {
        out[uid] = {
          location: '',
          location_source: '',
          ping_ms: 0,
          voice_channel_id: null,
          name: '',
          avatar_url: '',
        };
      }
    }
    return out;
  }

  async voicePresenceMap(
    serverId: number,
  ): Promise<Record<string, Array<{ identity: string; name: string; user_id: number; avatar_url: string }>>> {
    const info = await this.presenceInfo(serverId);
    const map: Record<string, Array<{ identity: string; name: string; user_id: number; avatar_url: string }>> = {};
    for (const [uid, meta] of Object.entries(info)) {
      const ch = meta.voice_channel_id;
      if (!ch) continue;
      const key = String(ch);
      if (!map[key]) map[key] = [];
      map[key].push({
        identity: userIdentity(Number(uid), process.env.LIVEKIT_IDENTITY_PREFIX || 'sfr'),
        name: meta.name || `u${uid}`,
        user_id: Number(uid),
        avatar_url: meta.avatar_url || '',
      });
    }
    return map;
  }
}
