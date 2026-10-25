import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AccessToken } from 'livekit-server-sdk';
import { randomBytes } from 'crypto';
import { userIdentity, voiceRoomName } from '@steamfarm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { VoiceService } from '../voice/voice.service';
import { assertPermission } from '../common/permissions';

const GUEST_PREFIX = 'guest-';

function clampMax(n: number) {
  return Math.max(1, Math.min(500, Math.floor(Number(n) || 50)));
}

function newWatchSlug() {
  return randomBytes(12).toString('base64url').replace(/[-_]/g, '').slice(0, 20);
}

function normalizeGuestName(raw: string, allowCustom: boolean) {
  if (!allowCustom) return 'Convidado';
  const suffix = String(raw || '')
    .trim()
    .replace(/[^\w\s\-]/gu, '')
    .replace(/\s+/g, ' ')
    .slice(0, 20);
  return suffix ? `Convidado-${suffix}` : 'Convidado';
}

@Injectable()
export class LiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly voice: VoiceService,
  ) {}

  private roomPrefix() {
    return (process.env.LIVEKIT_ROOM_PREFIX || 'sfr').trim() || 'sfr';
  }

  private identityPrefix() {
    return (process.env.LIVEKIT_IDENTITY_PREFIX || 'sfr').trim() || 'sfr';
  }

  watchUrl(slug: string, origin = '') {
    const s = (slug || '').trim();
    if (!s) return '';
    const base = (origin || '').replace(/\/$/, '');
    return base ? `${base}/assistir/${s}` : `/assistir/${s}`;
  }

  async endOtherSessions(userId: number, keepId?: number) {
    const now = Date.now() / 1000;
    const active = await this.prisma.communityLiveSession.findMany({
      where: {
        userId,
        status: { in: ['starting', 'live'] },
        ...(keepId ? { id: { not: keepId } } : {}),
      },
    });
    for (const row of active) {
      await this.prisma.communityLiveSession.update({
        where: { id: row.id },
        data: {
          status: 'ended',
          endedAt: now,
          watchSlug: '',
          publicWatchEnabled: false,
        },
      });
    }
  }

  async start(opts: {
    userId: number;
    serverId: number;
    channelId: number;
    title?: string;
    publicWatch?: boolean;
    publicWatchMax?: number;
    publicWatchCustomNames?: boolean;
    publicWatchChat?: boolean;
    publicWatchChatPost?: boolean;
    origin?: string;
  }) {
    const publicWatch = !!opts.publicWatch;
    if (!publicWatch) {
      throw new BadRequestException({
        ok: false,
        error: 'Ative o link público para iniciar a transmissão da tela.',
      });
    }
    const channel = await this.prisma.communityChannel.findUnique({
      where: { id: opts.channelId },
    });
    if (!channel || channel.serverId !== opts.serverId) {
      throw new BadRequestException({ ok: false, error: 'Canal inválido.' });
    }
    if (!['voice', 'screen'].includes(channel.kind)) {
      throw new BadRequestException({ ok: false, error: 'Só em canais de voz/tela.' });
    }
    const member = await this.prisma.communityMember.findUnique({
      where: {
        serverId_userId: { serverId: opts.serverId, userId: opts.userId },
      },
    });
    if (!member) throw new BadRequestException({ ok: false, error: 'not_member' });
    await assertPermission(this.prisma, member, 'live.go_live');

    await this.endOtherSessions(opts.userId);
    const now = Date.now() / 1000;
    const room = voiceRoomName(opts.serverId, opts.channelId, this.roomPrefix());
    const slug = newWatchSlug();
    const title =
      String(opts.title || '').trim().slice(0, 200) ||
      'Reunião — SteamFarm Comunidade';
    const sess = await this.prisma.communityLiveSession.create({
      data: {
        serverId: opts.serverId,
        channelId: opts.channelId,
        userId: opts.userId,
        title,
        status: 'live',
        livekitRoom: room,
        livekitEgressId: '',
        chatMeta: {},
        watchSlug: slug,
        publicWatchEnabled: true,
        publicWatchMax: clampMax(opts.publicWatchMax ?? 50),
        publicWatchCustomNames: opts.publicWatchCustomNames !== false,
        publicWatchChatEnabled: !!opts.publicWatchChat,
        publicWatchChatGuestPost: !!opts.publicWatchChat && !!opts.publicWatchChatPost,
        startedAt: now,
      },
    });
    return {
      ok: true as const,
      id: sess.id,
      mode: 'community' as const,
      title: sess.title,
      status: sess.status,
      public_watch_enabled: true,
      public_watch_max: sess.publicWatchMax,
      public_watch_custom_names: sess.publicWatchCustomNames,
      public_watch_chat_enabled: sess.publicWatchChatEnabled,
      public_watch_chat_guest_post: sess.publicWatchChatGuestPost,
      watch_slug: sess.watchSlug,
      watch_url: this.watchUrl(sess.watchSlug, opts.origin || ''),
      livekit_room: room,
    };
  }

  async stop(userId: number, sessionId?: number) {
    const now = Date.now() / 1000;
    let sess = sessionId
      ? await this.prisma.communityLiveSession.findUnique({ where: { id: sessionId } })
      : await this.prisma.communityLiveSession.findFirst({
          where: { userId, status: { in: ['starting', 'live'] } },
          orderBy: { startedAt: 'desc' },
        });
    if (!sess || sess.userId !== userId) {
      return { ok: true as const, stopped: false };
    }
    await this.prisma.communityLiveSession.update({
      where: { id: sess.id },
      data: {
        status: 'ended',
        endedAt: now,
        watchSlug: '',
        publicWatchEnabled: false,
      },
    });
    return { ok: true as const, stopped: true, id: sess.id };
  }

  async activeForUser(userId: number, origin = '') {
    const sess = await this.prisma.communityLiveSession.findFirst({
      where: { userId, status: { in: ['starting', 'live'] } },
      orderBy: { startedAt: 'desc' },
    });
    if (!sess) return { ok: true as const, live: null };
    return {
      ok: true as const,
      live: {
        id: sess.id,
        title: sess.title,
        status: sess.status,
        public_watch_enabled: sess.publicWatchEnabled,
        watch_slug: sess.watchSlug,
        watch_url: sess.publicWatchEnabled
          ? this.watchUrl(sess.watchSlug, origin)
          : '',
        channel_id: sess.channelId,
        server_id: sess.serverId,
      },
    };
  }

  /** Quantos convidados públicos estão na sala da sessão agora (LiveKit é a fonte). */
  private async guestCount(sess: { serverId: number; channelId: number; livekitRoom: string | null }) {
    const room = sess.livekitRoom || voiceRoomName(sess.serverId, sess.channelId, this.roomPrefix());
    const ids = await this.voice.listRoomIdentities(room);
    return ids.filter((id) => id.startsWith(GUEST_PREFIX)).length;
  }

  async publicInfo(slug: string, origin = '') {
    const sess = await this.prisma.communityLiveSession.findFirst({
      where: { watchSlug: (slug || '').trim() },
      orderBy: { startedAt: 'desc' },
    });
    if (!sess) throw new NotFoundException({ ok: false, error: 'Transmissão não encontrada.' });
    if (!['starting', 'live'].includes(sess.status)) {
      throw new BadRequestException({ ok: false, error: 'Esta transmissão não está ao vivo.' });
    }
    if (!sess.publicWatchEnabled || !sess.watchSlug) {
      throw new BadRequestException({ ok: false, error: 'Link público desativado.' });
    }
    const user = await this.prisma.user.findUnique({ where: { id: sess.userId } });
    const viewerCount = await this.guestCount(sess);
    return {
      ok: true as const,
      slug: sess.watchSlug,
      title: sess.title,
      status: sess.status,
      streamer_name: (user?.displayName || user?.username || `u${sess.userId}`).slice(0, 64),
      streamer_avatar: user?.avatarUrl || '',
      viewer_count: viewerCount,
      max_viewers: sess.publicWatchMax,
      watch_url: this.watchUrl(sess.watchSlug, origin),
      livekit_ready: this.voice.isReady(),
      custom_names_allowed: sess.publicWatchCustomNames,
      chat_enabled: sess.publicWatchChatEnabled,
      chat_guest_post: sess.publicWatchChatGuestPost,
      session_id: sess.id,
      streamer_identity: userIdentity(sess.userId, this.identityPrefix()),
    };
  }

  async guestToken(slug: string, guestLabel = '') {
    if (!this.voice.isReady()) {
      throw new ServiceUnavailableException({ ok: false, error: 'LiveKit não configurado.' });
    }
    const sess = await this.prisma.communityLiveSession.findFirst({
      where: { watchSlug: (slug || '').trim() },
      orderBy: { startedAt: 'desc' },
    });
    if (!sess) throw new NotFoundException({ ok: false, error: 'Transmissão não encontrada.' });
    if (!['starting', 'live'].includes(sess.status)) {
      throw new BadRequestException({ ok: false, error: 'Transmissão encerrada.' });
    }
    if (!sess.publicWatchEnabled || !sess.watchSlug) {
      throw new BadRequestException({ ok: false, error: 'Link público indisponível.' });
    }
    const room =
      sess.livekitRoom ||
      voiceRoomName(sess.serverId, sess.channelId, this.roomPrefix());
    // Limite de espectadores: conta os convidados (`guest-*`) que já estão na sala
    const max = Number(sess.publicWatchMax) || 0;
    if (max > 0 && (await this.guestCount(sess)) >= max) {
      throw new BadRequestException({ ok: false, error: 'Transmissão lotada.', code: 'watch_full' });
    }
    const guestId = `${GUEST_PREFIX}${randomBytes(6).toString('hex')}`;
    const name = normalizeGuestName(guestLabel, sess.publicWatchCustomNames);
    const at = new AccessToken(process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!, {
      identity: guestId,
      name: name.slice(0, 64),
    });
    at.addGrant({
      roomJoin: true,
      room,
      canPublish: false,
      canSubscribe: true,
      canPublishData: false,
    });
    const token = await at.toJwt();
    return {
      ok: true as const,
      token,
      url: this.voice.url(),
      room,
      identity: guestId,
      display_name: name,
      max_viewers: sess.publicWatchMax,
      session_id: sess.id,
      streamer_identity: userIdentity(sess.userId, this.identityPrefix()),
    };
  }
}
