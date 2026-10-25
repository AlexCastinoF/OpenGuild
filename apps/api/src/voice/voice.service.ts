import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { userIdFromIdentity, userIdentity, voiceRoomName } from '@steamfarm/shared';

@Injectable()
export class VoiceService {
  private roomPrefix() {
    return (process.env.LIVEKIT_ROOM_PREFIX || 'sfr').trim() || 'sfr';
  }

  private identityPrefix() {
    return (process.env.LIVEKIT_IDENTITY_PREFIX || 'sfr').trim() || 'sfr';
  }

  isReady() {
    return !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
  }

  url() {
    return process.env.LIVEKIT_URL || '';
  }

  apiUrl() {
    const explicit = (process.env.LIVEKIT_API_URL || '').trim().replace(/\/$/, '');
    if (explicit) return explicit;
    const url = this.url();
    if (url.startsWith('wss://')) return `https://${url.slice(6)}`;
    if (url.startsWith('ws://')) return `http://${url.slice(5)}`;
    return url;
  }

  private roomClient() {
    if (!this.isReady()) {
      throw new ServiceUnavailableException({ ok: false, error: 'livekit_unavailable' });
    }
    return new RoomServiceClient(
      this.apiUrl(),
      process.env.LIVEKIT_API_KEY!,
      process.env.LIVEKIT_API_SECRET!,
    );
  }

  /** Identidades presentes numa sala (vazio se LiveKit fora ou sala inexistente). */
  async listRoomIdentities(room: string): Promise<string[]> {
    if (!this.isReady()) return [];
    try {
      const parts = await this.roomClient().listParticipants(room);
      return (parts || []).map((p) => String(p.identity || ''));
    } catch {
      return [];
    }
  }

  async tokenForChannel(opts: {
    serverId: number;
    channelId: number;
    userId: number;
    name: string;
    avatarUrl: string;
    kind: string;
  }) {
    if (!this.isReady()) {
      throw new ServiceUnavailableException({ ok: false, error: 'livekit_unavailable' });
    }
    const room = voiceRoomName(opts.serverId, opts.channelId, this.roomPrefix());
    const identity = userIdentity(opts.userId, this.identityPrefix());
    const at = new AccessToken(process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!, {
      identity,
      name: (opts.name || identity).slice(0, 64),
      metadata: (opts.avatarUrl || '').slice(0, 256),
    });
    at.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    const token = await at.toJwt();
    return {
      ok: true as const,
      token,
      url: this.url(),
      room,
      identity,
      name: opts.name,
      avatar_url: opts.avatarUrl || '',
      channel_id: opts.channelId,
      kind: opts.kind,
    };
  }

  /** Lista quem está em cada canal de voz/tela (fonte de verdade do roster, como no Flask). */
  async listVoicePresence(
    serverId: number,
    channels: Array<{ id: number }>,
  ): Promise<
    Record<
      string,
      Array<{ identity: string; name: string; user_id: number; avatar_url: string }>
    >
  > {
    const out: Record<
      string,
      Array<{ identity: string; name: string; user_id: number; avatar_url: string }>
    > = {};
    for (const ch of channels) out[String(ch.id)] = [];
    if (!this.isReady() || !channels.length) return out;

    const client = this.roomClient();
    await Promise.all(
      channels.map(async (ch) => {
        const room = voiceRoomName(serverId, ch.id, this.roomPrefix());
        try {
          const parts = await client.listParticipants(room);
          out[String(ch.id)] = (parts || []).map((p) => {
            const identity = String(p.identity || '');
            const uid = userIdFromIdentity(identity);
            return {
              identity,
              name: String(p.name || identity),
              user_id: uid,
              avatar_url: String(p.metadata || '').trim(),
            };
          });
        } catch {
          /* sala inexistente / vazia */
        }
      }),
    );
    return out;
  }

  /** Remove um participante de uma sala LiveKit (desconectar da voz). */
  async removeParticipant(serverId: number, channelId: number, targetUserId: number) {
    if (!this.isReady()) {
      throw new ServiceUnavailableException({ ok: false, error: 'livekit_unavailable' });
    }
    const room = voiceRoomName(serverId, channelId, this.roomPrefix());
    const identity = userIdentity(targetUserId, this.identityPrefix());
    const client = this.roomClient();
    try {
      await client.removeParticipant(room, identity);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found|does not exist|participant/i.test(msg)) {
        return { ok: true as const, removed: false, room, identity };
      }
      throw err;
    }
    return { ok: true as const, removed: true, room, identity };
  }
}
