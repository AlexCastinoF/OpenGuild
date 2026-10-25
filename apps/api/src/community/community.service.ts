import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import {
  DEFAULT_ADMIN_PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
} from '@steamfarm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { PresenceService } from '../presence/presence.service';
import { GeoService } from '../presence/geo.service';
import { VoiceService } from '../voice/voice.service';
import { PabxService } from '../pabx/pabx.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { assertMatchVoiceJoin } from '../private-match/match-voice-acl';
import { assertPermission, memberPermissions as effectivePermissions } from '../common/permissions';

const BORDER_EFFECTS = new Set(['none', 'solid', 'glow', 'neon', 'double']);
const BORDER_MOTIONS = new Set(['none', 'pulse', 'laser', 'shimmer']);

function normalizeBorderEffect(value?: string) {
  if (value == null || value === '') return undefined;
  const v = String(value).toLowerCase();
  return BORDER_EFFECTS.has(v) ? v : 'solid';
}

function normalizeBorderMotion(value?: string) {
  if (value == null || value === '') return undefined;
  const v = String(value).toLowerCase();
  return BORDER_MOTIONS.has(v) ? v : 'none';
}

@Injectable()
export class CommunityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly presence: PresenceService,
    private readonly geo: GeoService,
    private readonly voice: VoiceService,
    private readonly pabx: PabxService,
    @Inject(forwardRef(() => RealtimeGateway))
    private readonly realtime: RealtimeGateway,
  ) {}

  private async memberOrThrow(serverId: number, userId: number) {
    const m = await this.prisma.communityMember.findUnique({
      where: { serverId_userId: { serverId, userId } },
    });
    if (!m) throw new ForbiddenException({ ok: false, error: 'not_a_member' });
    return m;
  }

  /**
   * Permissões efetivas (common/permissions.ts): dono tem tudo; admin = base de admin ∪ cargos;
   * membro = cargo `@everyone` ∪ cargos atribuídos. Antes, o `@everyone` do banco era ignorado
   * e a maioria das ações de moderação checava só `role !== 'member'`.
   */
  private async memberPermissions(serverId: number, userId: number) {
    const m = await this.memberOrThrow(serverId, userId);
    const perms = await effectivePermissions(this.prisma, m);
    return { member: m, permissions: [...perms] };
  }

  private async requirePerm(serverId: number, userId: number, key: string) {
    const { member, permissions } = await this.memberPermissions(serverId, userId);
    if (!permissions.includes(key)) {
      throw new ForbiddenException({ ok: false, error: 'forbidden', missing_permission: key });
    }
    return { member, permissions };
  }

  /**
   * Avisa a sala do servidor que a lista de voz/presença mudou: o front refaz o
   * `voice-presence` na hora em vez de esperar o próximo polling.
   */
  private notifyPresence(serverId: number) {
    this.realtime.emitToServer(serverId, 'presence:changed', { server_id: serverId });
  }

  /** Tira o usuário da sala LiveKit em que estiver neste servidor e zera a presença de voz. */
  private async dropFromVoice(serverId: number, userId: number): Promise<number | null> {
    let chId: number | null = null;
    try {
      const map = await this.presence.voicePresenceMap(serverId);
      for (const [cid, people] of Object.entries(map)) {
        if (people.some((p) => p.user_id === userId)) {
          chId = Number(cid);
          break;
        }
      }
      if (chId) await this.voice.removeParticipant(serverId, chId, userId);
    } catch {
      /* LiveKit fora ou usuário já saiu: não bloqueia a ação */
    }
    await this.presence.clearActiveVoice(userId, { serverId }).catch(() => undefined);
    await this.presence.setVoiceChannel(serverId, userId, null).catch(() => undefined);
    this.notifyPresence(serverId);
    return chId;
  }

  /**
   * Derruba o usuário de tudo que é do servidor: voz, sala do socket e a tela do front
   * (`server:removed` → o CommunityPage sai do servidor). Usado por expulsão, bloqueio e exclusão.
   */
  private async expelFromServer(
    serverId: number,
    userId: number,
    reason: 'kicked' | 'blocked' | 'deleted',
  ) {
    await this.dropFromVoice(serverId, userId);
    await this.realtime.leaveServerRooms(userId, serverId).catch(() => undefined);
    this.realtime.emitToUser(userId, 'server:removed', { server_id: serverId, reason });
  }

  /** Aplica `expelFromServer` a todos os membros (bloqueio ou exclusão do servidor). */
  private async expelAllMembers(serverId: number, reason: 'blocked' | 'deleted') {
    const members = await this.prisma.communityMember.findMany({
      where: { serverId },
      select: { userId: true },
    });
    for (const m of members) await this.expelFromServer(serverId, m.userId, reason);
  }

  async listServers(userId: number) {
    const memberships = await this.prisma.communityMember.findMany({
      where: { userId },
      include: { server: true },
      orderBy: { joinedAt: 'asc' },
    });
    return {
      ok: true as const,
      servers: memberships.map((m) => ({
        id: m.server.id,
        name: m.server.name,
        owner_user_id: m.server.ownerUserId,
        role: m.role as 'owner' | 'admin' | 'member',
        icon_url: m.server.iconUrl,
        banner_url: m.server.bannerUrl,
        description: m.server.description,
        is_listed: m.server.isListed,
        created_at: m.server.createdAt,
      })),
    };
  }

  async createServer(userId: number, name: string) {
    const trimmed = (name || '').trim().slice(0, 80);
    if (trimmed.length < 2) throw new BadRequestException({ ok: false, error: 'Nome inválido' });
    const now = Date.now() / 1000;
    const server = await this.prisma.$transaction(async (tx) => {
      const s = await tx.communityServer.create({
        data: {
          name: trimmed,
          ownerUserId: userId,
          createdAt: now,
        },
      });
      await tx.communityMember.create({
        data: { serverId: s.id, userId, role: 'owner', joinedAt: now },
      });
      await tx.communityRole.createMany({
        data: [
          {
            serverId: s.id,
            name: '@everyone',
            color: '#949ba4',
            position: 0,
            permissions: [...DEFAULT_EVERYONE_PERMISSIONS],
            isDefault: true,
            createdAt: now,
          },
          {
            serverId: s.id,
            name: 'Admin',
            color: '#ed4245',
            position: 1,
            permissions: [...DEFAULT_ADMIN_PERMISSIONS],
            isDefault: false,
            createdAt: now,
          },
        ],
      });
      await tx.communityChannel.createMany({
        data: [
          { serverId: s.id, name: 'geral', kind: 'text', position: 0, createdAt: now },
          { serverId: s.id, name: 'voz', kind: 'voice', position: 1, createdAt: now },
          { serverId: s.id, name: 'tela', kind: 'screen', position: 2, createdAt: now },
        ],
      });
      return s;
    });
    return {
      ok: true as const,
      server: {
        id: server.id,
        name: server.name,
        owner_user_id: server.ownerUserId,
        role: 'owner' as const,
      },
    };
  }

  async getServer(serverId: number, userId: number) {
    await this.memberOrThrow(serverId, userId);
    const server = await this.prisma.communityServer.findUnique({
      where: { id: serverId },
      include: {
        channels: { orderBy: { position: 'asc' } },
        members: { include: { user: true } },
        roles: { orderBy: { position: 'asc' } },
        memberRoles: { include: { role: true } },
        joinRequests: { where: { status: 'pending' } },
      },
    });
    if (!server) throw new NotFoundException({ ok: false, error: 'not_found' });
    if (server.isBlocked) {
      throw new ForbiddenException({ ok: false, error: 'server_blocked' });
    }
    const me = server.members.find((m) => m.userId === userId)!;
    const rolesByUser = new Map<number, typeof server.memberRoles>();
    for (const mr of server.memberRoles) {
      const list = rolesByUser.get(mr.userId) || [];
      list.push(mr);
      rolesByUser.set(mr.userId, list);
    }
    return {
      ok: true as const,
      server: {
        id: server.id,
        name: server.name,
        owner_user_id: server.ownerUserId,
        role: me.role,
        icon_url: server.iconUrl,
        banner_url: server.bannerUrl,
        description: server.description,
        is_listed: server.isListed,
        is_blocked: server.isBlocked,
        created_at: server.createdAt,
        pending_requests: server.joinRequests.length,
        // As mesmas permissões que a API aplica (cargos + papel legado + @everyone)
        permissions: [...(await effectivePermissions(this.prisma, { serverId, userId, role: me.role }))],
        roles: server.roles.map((r) => ({
          id: r.id,
          name: r.name,
          color: r.color,
          position: r.position,
          permissions: r.permissions,
          is_default: r.isDefault,
          hoist: r.hoist,
          member_card_color: r.memberCardColor,
          border_color: r.borderColor,
          border_effect: r.borderEffect,
          border_motion: r.borderMotion,
        })),
        channels: server.channels.map((c) => ({
          id: c.id,
          name: c.name,
          kind: c.kind,
          position: c.position,
          icon_url: c.iconUrl,
        })),
        members: server.members.map((m) => {
          const custom = (rolesByUser.get(m.userId) || [])
            .filter((mr) => !mr.role.isDefault)
            .sort((a, b) => b.role.position - a.role.position)
            .map((mr) => ({
              id: mr.role.id,
              name: mr.role.name,
              color: mr.role.color,
              position: mr.role.position,
              member_card_color: mr.role.memberCardColor,
              border_color: mr.role.borderColor,
              border_effect: mr.role.borderEffect,
              border_motion: mr.role.borderMotion,
            }));
          const card =
            custom.find((r) => r.member_card_color)?.member_card_color ||
            custom[0]?.color ||
            null;
          return {
            ...this.users.toPublicUser(m.user),
            role: m.role,
            joined_at: m.joinedAt,
            custom_roles: custom,
            card_color: card,
          };
        }),
        livekit: this.voice.isReady(),
        livekit_url: this.voice.url(),
      },
    };
  }

  async patchServer(
    serverId: number,
    userId: number,
    data: {
      name?: string;
      description?: string;
      is_listed?: boolean;
      icon_url?: string;
      banner_url?: string;
    },
  ) {
    await this.requirePerm(serverId, userId, 'server.manage');
    const server = await this.prisma.communityServer.update({
      where: { id: serverId },
      data: {
        name: data.name?.trim().slice(0, 80),
        description: data.description,
        isListed: data.is_listed,
        iconUrl: data.icon_url,
        bannerUrl: data.banner_url,
      },
    });
    return {
      ok: true as const,
      server: {
        id: server.id,
        name: server.name,
        description: server.description,
        is_listed: server.isListed,
        icon_url: server.iconUrl,
        banner_url: server.bannerUrl,
      },
    };
  }

  async deleteServer(serverId: number, userId: number) {
    await this.requirePerm(serverId, userId, 'server.delete');
    await this.expelAllMembers(serverId, 'deleted');
    // Live sessions não têm FK Prisma — limpar antes do delete (igual ao adminDeleteServer)
    await this.prisma.communityLiveSession.deleteMany({ where: { serverId } });
    await this.prisma.communityServer.delete({ where: { id: serverId } });
    return { ok: true as const };
  }

  async createChannel(
    serverId: number,
    userId: number,
    input: { name: string; kind?: string },
  ) {
    await this.requirePerm(serverId, userId, 'channels.create');
    const kind = ['text', 'voice', 'screen'].includes(input.kind || '') ? input.kind! : 'text';
    const max = await this.prisma.communityChannel.aggregate({
      where: { serverId },
      _max: { position: true },
    });
    const channel = await this.prisma.communityChannel.create({
      data: {
        serverId,
        name: (input.name || 'canal').trim().slice(0, 64),
        kind,
        position: (max._max.position ?? -1) + 1,
        createdAt: Date.now() / 1000,
      },
    });
    return {
      ok: true as const,
      channel: {
        id: channel.id,
        name: channel.name,
        kind: channel.kind,
        position: channel.position,
        icon_url: channel.iconUrl,
      },
    };
  }

  async patchChannel(
    channelId: number,
    userId: number,
    data: { name?: string; icon_url?: string },
  ) {
    const channel = await this.prisma.communityChannel.findUnique({ where: { id: channelId } });
    if (!channel) throw new NotFoundException({ ok: false, error: 'not_found' });
    await this.requirePerm(channel.serverId, userId, 'channels.edit');
    const updated = await this.prisma.communityChannel.update({
      where: { id: channelId },
      data: {
        name: data.name?.trim().slice(0, 64),
        iconUrl: data.icon_url,
      },
    });
    return {
      ok: true as const,
      channel: {
        id: updated.id,
        name: updated.name,
        kind: updated.kind,
        position: updated.position,
        icon_url: updated.iconUrl,
      },
    };
  }

  async deleteChannel(channelId: number, userId: number) {
    const channel = await this.prisma.communityChannel.findUnique({ where: { id: channelId } });
    if (!channel) throw new NotFoundException({ ok: false, error: 'not_found' });
    await this.requirePerm(channel.serverId, userId, 'channels.delete');
    await this.prisma.communityChannel.delete({ where: { id: channelId } });
    return { ok: true as const };
  }

  async listMessages(channelId: number, userId: number, after?: number) {
    const channel = await this.prisma.communityChannel.findUnique({ where: { id: channelId } });
    if (!channel) throw new NotFoundException({ ok: false, error: 'not_found' });
    await this.memberOrThrow(channel.serverId, userId);
    const rows = after
      ? await this.prisma.communityMessage.findMany({
          where: { channelId, id: { gt: after } },
          include: { user: true },
          orderBy: { id: 'asc' },
          take: 80,
        })
      : (
          await this.prisma.communityMessage.findMany({
            where: { channelId },
            include: { user: true },
            orderBy: { id: 'desc' },
            take: 80,
          })
        ).reverse();
    return {
      ok: true as const,
      messages: rows.map((r) => ({
        id: r.id,
        channel_id: r.channelId,
        body: r.body,
        created_at: r.createdAt,
        user: this.users.toPublicUser(r.user),
        system:
          /^\s*⚙️/.test(r.body || '') || /Partida Privada Castino\.Tech/i.test(r.body || ''),
      })),
    };
  }

  async postMessage(channelId: number, userId: number, body: string) {
    const channel = await this.prisma.communityChannel.findUnique({ where: { id: channelId } });
    if (!channel) throw new NotFoundException({ ok: false, error: 'not_found' });
    await this.requirePerm(channel.serverId, userId, 'messages.send');
    if (channel.kind !== 'text') {
      throw new BadRequestException({ ok: false, error: 'not_text_channel' });
    }
    const text = (body || '').trim().slice(0, 4000);
    if (!text) throw new BadRequestException({ ok: false, error: 'empty' });
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException({ ok: false, error: 'not_found' });
    const msg = await this.prisma.communityMessage.create({
      data: {
        channelId,
        userId,
        body: text,
        createdAt: Date.now() / 1000,
      },
    });
    const dto = {
      id: msg.id,
      channel_id: msg.channelId,
      body: msg.body,
      created_at: msg.createdAt,
      user: this.users.toPublicUser(user),
    };
    this.realtime.emitToServer(channel.serverId, 'message:new', dto);
    return { ok: true as const, message: dto };
  }

  /** Mensagem de sistema no 1.º canal de texto do servidor (ex.: Partida Privada). */
  async postSystemToServer(serverId: number, actorUserId: number, body: string) {
    const channel = await this.prisma.communityChannel.findFirst({
      where: { serverId, kind: 'text' },
      orderBy: { id: 'asc' },
    });
    if (!channel) return { ok: false as const, error: 'no_text_channel' };
    const plain = String(body || '').trim().slice(0, 3900);
    if (!plain) return { ok: false as const, error: 'empty' };
    // Prefixo estável para a UI (⚙️ + texto) — estilo centrado sem avatar.
    const text = `⚙️ ${plain}`;
    try {
      await this.memberOrThrow(serverId, actorUserId);
      const user = await this.users.findById(actorUserId);
      if (!user) return { ok: false as const, error: 'no_user' };
      const msg = await this.prisma.communityMessage.create({
        data: {
          channelId: channel.id,
          userId: actorUserId,
          body: text,
          createdAt: Date.now() / 1000,
        },
      });
      const dto = {
        id: msg.id,
        channel_id: msg.channelId,
        body: msg.body,
        created_at: msg.createdAt,
        user: this.users.toPublicUser(user),
        system: true as const,
      };
      this.realtime.emitToServer(serverId, 'message:new', dto);
      this.realtime.emitToServer(serverId, 'server:system_notice', {
        body: plain,
        channel_id: channel.id,
        message_id: msg.id,
      });
      return { ok: true as const, message: dto };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async deleteMessage(channelId: number, messageId: number, userId: number) {
    const channel = await this.prisma.communityChannel.findUnique({ where: { id: channelId } });
    if (!channel) throw new NotFoundException({ ok: false, error: 'not_found' });
    const m = await this.memberOrThrow(channel.serverId, userId);
    const msg = await this.prisma.communityMessage.findUnique({ where: { id: messageId } });
    if (!msg || msg.channelId !== channelId) {
      throw new NotFoundException({ ok: false, error: 'not_found' });
    }
    await assertPermission(
      this.prisma,
      m,
      msg.userId === userId ? 'messages.delete_own' : 'messages.delete_any',
    );
    await this.prisma.communityMessage.delete({ where: { id: messageId } });
    return { ok: true as const };
  }

  async createInvite(serverId: number, userId: number) {
    await this.requirePerm(serverId, userId, 'invites.manage');
    const code = randomBytes(6).toString('hex');
    const invite = await this.prisma.communityInvite.create({
      data: {
        serverId,
        code,
        createdBy: userId,
        createdAt: Date.now() / 1000,
      },
    });
    const base = process.env.PUBLIC_BASE_URL || '';
    return {
      ok: true as const,
      invite: {
        code: invite.code,
        url: `${base}/convite/${invite.code}`,
      },
    };
  }

  async joinByCode(userId: number, code: string) {
    const invite = await this.prisma.communityInvite.findUnique({ where: { code } });
    if (!invite) throw new NotFoundException({ ok: false, error: 'invite_invalid' });
    if (invite.expiresAt > 0 && invite.expiresAt < Date.now() / 1000) {
      throw new BadRequestException({ ok: false, error: 'invite_expired' });
    }
    if (invite.maxUses > 0 && invite.uses >= invite.maxUses) {
      throw new BadRequestException({ ok: false, error: 'invite_exhausted' });
    }
    const existing = await this.prisma.communityMember.findUnique({
      where: { serverId_userId: { serverId: invite.serverId, userId } },
    });
    if (!existing) {
      await this.prisma.communityMember.create({
        data: {
          serverId: invite.serverId,
          userId,
          role: 'member',
          joinedAt: Date.now() / 1000,
        },
      });
      await this.prisma.communityInvite.update({
        where: { id: invite.id },
        data: { uses: { increment: 1 } },
      });
    }
    return { ok: true as const, server_id: invite.serverId };
  }

  async discover(userId: number) {
    const servers = await this.prisma.communityServer.findMany({
      where: { isListed: true },
      orderBy: { name: 'asc' },
      take: 50,
      include: {
        members: {
          where: { role: { in: ['owner', 'admin'] } },
          include: { user: true },
          take: 6,
        },
      },
    });
    const myMemberships = await this.prisma.communityMember.findMany({
      where: { userId },
      select: { serverId: true, role: true },
    });
    const memberMap = new Map(myMemberships.map((m) => [m.serverId, m.role]));
    const pending = await this.prisma.communityJoinRequest.findMany({
      where: { userId, status: 'pending', serverId: { in: servers.map((s) => s.id) } },
      select: { serverId: true },
    });
    const pendingSet = new Set(pending.map((p) => p.serverId));
    const counts = await this.prisma.communityMember.groupBy({
      by: ['serverId'],
      where: { serverId: { in: servers.map((s) => s.id) } },
      _count: { _all: true },
    });
    const countMap = new Map(counts.map((c) => [c.serverId, c._count._all]));

    return {
      ok: true as const,
      servers: servers.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        icon_url: s.iconUrl,
        banner_url: s.bannerUrl,
        is_listed: s.isListed,
        member_count: countMap.get(s.id) || 0,
        admins: s.members.map((m) => ({
          ...this.users.toPublicUser(m.user),
          role: m.role,
        })),
        is_member: memberMap.has(s.id),
        membership_role: memberMap.get(s.id) || null,
        join_pending: pendingSet.has(s.id),
      })),
    };
  }

  async voicePresence(
    serverId: number,
    userId: number,
    qs: {
      ping_ms?: string;
      lat?: string;
      lon?: string;
      voice_channel_id?: string;
    },
    clientIp = '',
  ) {
    await this.memberOrThrow(serverId, userId);
    const user = await this.users.findById(userId);
    const prevInfo = (await this.presence.presenceInfo(serverId))[String(userId)];
    const resolved = await this.geo.resolvePresenceLocation({
      lat: qs.lat,
      lon: qs.lon,
      ip: clientIp,
      prevLocation: prevInfo?.location,
      prevSource: prevInfo?.location_source,
      prevGpsTs: prevInfo?.gps_ts,
    });
    // Param presente com id = reforçar voz; vazio NÃO limpa (outra aba/heartbeat
    // derrubaria a sessão ativa). Limpeza só via voice-leave / offline.
    const requestedVoice =
      qs.voice_channel_id === undefined
        ? undefined
        : Number(qs.voice_channel_id) || null;
    const activeBefore = await this.presence.getActiveVoice(userId);
    let voice_revoked = false;
    const touchMeta: Parameters<typeof this.presence.touch>[2] = {
      ping_ms: Number(qs.ping_ms) || 0,
      location: resolved.location,
      location_source: resolved.location_source,
      gps_ts: resolved.gps_ts,
      name: user ? user.displayName || user.username : '',
      avatar_url: user?.avatarUrl || '',
    };
    if (requestedVoice) {
      if (
        !activeBefore ||
        (activeBefore.serverId === serverId && activeBefore.channelId === requestedVoice)
      ) {
        // Reforçar / primeira reivindicação neste canal
        touchMeta.voice_channel_id = requestedVoice;
        if (!activeBefore) {
          await this.presence.setActiveVoice(userId, serverId, requestedVoice);
        }
      } else if (activeBefore.serverId === serverId) {
        // Mesmo servidor, outro canal: migração da mesma sessão (join/troca).
        // NÃO revogar — o livekit-token já (ou vai) actualizar active_voice.
        // Revogar aqui derruba o LiveKit a meio do connect (palco vazio / não entra).
        touchMeta.voice_channel_id = requestedVoice;
        await this.presence.setActiveVoice(userId, serverId, requestedVoice);
      } else {
        // active_voice noutro servidor: esta aba ainda manda canal antigo → revogar local
        voice_revoked = true;
      }
    }
    await this.presence.touch(serverId, userId, touchMeta);

    const channels = await this.prisma.communityChannel.findMany({
      where: { serverId, kind: { in: ['voice', 'screen'] } },
      orderBy: { position: 'asc' },
    });
    const online = await this.presence.onlineUserIds(serverId);
    let info = await this.presence.presenceInfo(serverId);
    const members = await this.prisma.communityMember.findMany({
      where: { serverId },
      include: { user: true },
    });
    info = await this.presence.mergeActivities(
      info,
      members.map((m) => m.userId),
    );
    const work_statuses: Record<string, string> = {};
    const work_status_since: Record<string, number> = {};
    for (const m of members) {
      work_statuses[String(m.userId)] = m.user.workStatus || '';
      const since = Number(m.user.workStatusChangedAt) || 0;
      if (m.user.workStatus && since > 0) {
        work_status_since[String(m.userId)] = since;
      }
    }

    // Fonte de verdade = LiveKit; Redis complementa (quem ainda não aparece no RoomService
    // ou quando a API LiveKit falha) — assim o roster do canal aparece sem precisar entrar.
    const presence = await this.voice.listVoicePresence(
      serverId,
      channels.map((c) => ({ id: c.id })),
    );
    const redisPresence = await this.presence.voicePresenceMap(serverId);
    for (const ch of channels) {
      const key = String(ch.id);
      const byUser = new Map<
        number,
        { identity: string; name: string; user_id: number; avatar_url: string }
      >();
      for (const row of presence[key] || []) {
        if (row.user_id) byUser.set(row.user_id, row);
      }
      for (const row of redisPresence[key] || []) {
        if (row.user_id && !byUser.has(row.user_id)) byUser.set(row.user_id, row);
      }
      presence[key] = [...byUser.values()];
    }
    const usersById = new Map(members.map((m) => [m.userId, m.user]));
    for (const ch of channels) {
      const key = String(ch.id);
      const rows = presence[key] || [];
      presence[key] = rows.map((row) => {
        const u = row.user_id ? usersById.get(row.user_id) : undefined;
        const net = row.user_id ? info[String(row.user_id)] : undefined;
        return {
          identity: row.identity,
          name: row.name || u?.displayName || u?.username || row.identity,
          user_id: row.user_id,
          avatar_url: row.avatar_url || u?.avatarUrl || '',
          ramal: u?.ramal || '',
          work_status: u?.workStatus || '',
          location: net?.location || '',
          location_source: net?.location_source || '',
          ping_ms: net?.ping_ms ?? null,
        };
      });
    }

    // Quem está na voz (LiveKit) conta como online mesmo se o heartbeat Redis atrasar
    const onlineSet = new Set(online);
    for (const rows of Object.values(presence)) {
      for (const row of rows || []) {
        if (row.user_id) onlineSet.add(Number(row.user_id));
      }
    }

    const pabxSnap = await this.pabx.snapshot();
    const activeVoice = await this.presence.getActiveVoice(userId);

    return {
      ok: true as const,
      channels: channels.map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
      presence,
      online_users: [...onlineSet],
      presence_info: info,
      work_statuses,
      work_status_since,
      online_calls: pabxSnap.online_calls,
      on_call: pabxSnap.on_call,
      pabx: pabxSnap.pabx,
      active_voice: activeVoice
        ? { server_id: activeVoice.serverId, channel_id: activeVoice.channelId }
        : null,
      voice_revoked,
    };
  }

  async livekitToken(channelId: number, userId: number) {
    const channel = await this.prisma.communityChannel.findUnique({ where: { id: channelId } });
    if (!channel) throw new NotFoundException({ ok: false, error: 'not_found' });
    if (!['voice', 'screen'].includes(channel.kind)) {
      throw new BadRequestException({ ok: false, error: 'not_voice_channel' });
    }
    await this.requirePerm(channel.serverId, userId, 'voice.join');
    assertMatchVoiceJoin(channel.id, userId);
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException({ ok: false, error: 'not_found' });

    // Uma voz por usuário: kicka sessões/abas anteriores e limpa Redis nos outros canais
    const prevActive = await this.presence.getActiveVoice(userId);
    const prevOnServer = (await this.presence.presenceInfo(channel.serverId))[String(userId)];
    const fromOthers = await this.presence.clearVoiceEverywhere(userId, channel.serverId);
    const toKick: Array<{ serverId: number; channelId: number }> = [...fromOthers];
    if (
      prevActive &&
      (prevActive.serverId !== channel.serverId || prevActive.channelId !== channel.id)
    ) {
      toKick.push(prevActive);
    }
    if (
      prevOnServer?.voice_channel_id &&
      Number(prevOnServer.voice_channel_id) !== channel.id
    ) {
      toKick.push({
        serverId: channel.serverId,
        channelId: Number(prevOnServer.voice_channel_id),
      });
    }
    const seen = new Set<string>();
    for (const prev of toKick) {
      const key = `${prev.serverId}:${prev.channelId}`;
      if (seen.has(key)) continue;
      if (prev.serverId === channel.serverId && prev.channelId === channel.id) continue;
      seen.add(key);
      try {
        await this.voice.removeParticipant(prev.serverId, prev.channelId, userId);
      } catch {
        /* sala vazia / já saiu */
      }
    }

    await this.presence.setVoiceChannel(channel.serverId, userId, channel.id);
    this.notifyPresence(channel.serverId);
    return this.voice.tokenForChannel({
      serverId: channel.serverId,
      channelId: channel.id,
      userId,
      name: user.displayName || user.username,
      avatarUrl: user.avatarUrl,
      kind: channel.kind,
    });
  }

  async leaveVoice(
    serverId: number,
    userId: number,
    opts: { offline?: boolean; channelId?: number } = {},
  ) {
    await this.memberOrThrow(serverId, userId);
    const active = await this.presence.getActiveVoice(userId);
    const matchesActive =
      !!active &&
      active.serverId === serverId &&
      (opts.channelId == null || active.channelId === opts.channelId);

    if (matchesActive && active) {
      try {
        await this.voice.removeParticipant(serverId, active.channelId, userId);
      } catch {
        /* ignore */
      }
      await this.presence.clearActiveVoice(userId);
      await this.presence.touch(serverId, userId, { voice_channel_id: null });
      this.notifyPresence(serverId);
    } else if (!active || active.serverId !== serverId) {
      // Sem sessão ativa neste servidor — só limpa flag local se ainda houver
      await this.presence.touch(serverId, userId, { voice_channel_id: null });
    }
    // Aba stale (active em outro canal/servidor): não mexe no active_voice

    if (opts.offline) {
      const activeNow = await this.presence.getActiveVoice(userId);
      // Outra aba ainda na voz neste servidor → não tirar o online
      if (activeNow && activeNow.serverId === serverId) {
        return { ok: true as const };
      }
      await this.presence.clear(serverId, userId);
      await this.presence.clearActiveVoice(userId, { serverId });
    }
    return { ok: true as const };
  }

  async reorderChannels(serverId: number, userId: number, order: number[]) {
    await this.requirePerm(serverId, userId, 'channels.reorder');
    const channels = await this.prisma.communityChannel.findMany({ where: { serverId } });
    const ids = new Set(channels.map((c) => c.id));
    const cleaned = order.map(Number).filter((id) => ids.has(id));
    await this.prisma.$transaction(
      cleaned.map((id, idx) =>
        this.prisma.communityChannel.update({ where: { id }, data: { position: idx } }),
      ),
    );
    const updated = await this.prisma.communityChannel.findMany({
      where: { serverId },
      orderBy: { position: 'asc' },
    });
    return {
      ok: true as const,
      channels: updated.map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        position: c.position,
        icon_url: c.iconUrl,
      })),
    };
  }

  async kickMember(serverId: number, userId: number, targetId: number) {
    const { member: m } = await this.requirePerm(serverId, userId, 'members.kick');
    if (targetId === userId) throw new BadRequestException({ ok: false, error: 'cannot_kick_self' });
    const target = await this.memberOrThrow(serverId, targetId);
    if (target.role === 'owner') throw new ForbiddenException({ ok: false, error: 'cannot_kick_owner' });
    if (target.role === 'admin' && m.role !== 'owner') {
      throw new ForbiddenException({ ok: false, error: 'forbidden' });
    }
    await this.prisma.communityMember.delete({
      where: { serverId_userId: { serverId, userId: targetId } },
    });
    await this.prisma.communityMemberRole.deleteMany({
      where: { serverId, userId: targetId },
    });
    // Expulso sai da voz e do socket na hora, e o front dele fecha o servidor
    await this.expelFromServer(serverId, targetId, 'kicked');
    return { ok: true as const };
  }

  async listRoles(serverId: number, userId: number) {
    await this.memberOrThrow(serverId, userId);
    const roles = await this.prisma.communityRole.findMany({
      where: { serverId },
      orderBy: { position: 'asc' },
    });
    return {
      ok: true as const,
      roles: roles.map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        position: r.position,
        hoist: r.hoist,
        permissions: r.permissions,
        is_default: r.isDefault,
        member_card_color: r.memberCardColor,
        border_color: r.borderColor,
        border_effect: r.borderEffect,
        border_motion: r.borderMotion,
      })),
    };
  }

  async createRole(
    serverId: number,
    userId: number,
    data: { name: string; color?: string; permissions?: string[] },
  ) {
    await this.requirePerm(serverId, userId, 'roles.manage');
    const max = await this.prisma.communityRole.aggregate({
      where: { serverId },
      _max: { position: true },
    });
    const role = await this.prisma.communityRole.create({
      data: {
        serverId,
        name: (data.name || 'Cargo').trim().slice(0, 64),
        color: data.color || '#949ba4',
        position: (max._max.position ?? 0) + 1,
        permissions: data.permissions || [...DEFAULT_EVERYONE_PERMISSIONS],
        createdAt: Date.now() / 1000,
      },
    });
    return { ok: true as const, role: { id: role.id, name: role.name, color: role.color } };
  }

  async patchRole(
    serverId: number,
    roleId: number,
    userId: number,
    data: {
      name?: string;
      color?: string;
      permissions?: string[];
      hoist?: boolean;
      member_card_color?: string | null;
      border_color?: string | null;
      border_effect?: string;
      border_motion?: string;
    },
  ) {
    const { member: m } = await this.requirePerm(serverId, userId, 'roles.manage');
    const role = await this.prisma.communityRole.findFirst({ where: { id: roleId, serverId } });
    if (!role) throw new NotFoundException({ ok: false, error: 'not_found' });
    // Só o dono mexe nas permissões do cargo Admin (senão um admin se dá tudo)
    if (
      data.permissions !== undefined &&
      !role.isDefault &&
      role.name.trim().toLowerCase() === 'admin' &&
      m.role !== 'owner'
    ) {
      throw new ForbiddenException({ ok: false, error: 'only_owner_can_edit_admin' });
    }
    const effect = normalizeBorderEffect(data.border_effect);
    const motion = normalizeBorderMotion(data.border_motion);
    const updated = await this.prisma.communityRole.update({
      where: { id: roleId },
      data: {
        name: data.name?.trim().slice(0, 64),
        color: data.color,
        permissions: data.permissions,
        hoist: data.hoist,
        memberCardColor: data.member_card_color,
        borderColor: data.border_color === undefined ? undefined : data.border_color || null,
        borderEffect: effect,
        borderMotion: motion,
      },
    });
    return {
      ok: true as const,
      role: {
        id: updated.id,
        name: updated.name,
        color: updated.color,
        permissions: updated.permissions,
        border_color: updated.borderColor,
        border_effect: updated.borderEffect,
        border_motion: updated.borderMotion,
      },
    };
  }

  async deleteRole(serverId: number, roleId: number, userId: number) {
    await this.requirePerm(serverId, userId, 'roles.manage');
    const role = await this.prisma.communityRole.findFirst({ where: { id: roleId, serverId } });
    if (!role) throw new NotFoundException({ ok: false, error: 'not_found' });
    if (role.isDefault) throw new BadRequestException({ ok: false, error: 'cannot_delete_default' });
    await this.prisma.communityRole.delete({ where: { id: roleId } });
    return { ok: true as const };
  }

  async setMemberRoles(serverId: number, userId: number, targetId: number, roleIds: number[]) {
    const { member: m } = await this.requirePerm(serverId, userId, 'members.assign_roles');
    const target = await this.memberOrThrow(serverId, targetId);
    if (target.role === 'owner') {
      throw new BadRequestException({ ok: false, error: 'cannot_edit_owner_roles' });
    }
    if (target.role === 'admin' && m.role !== 'owner') {
      throw new ForbiddenException({ ok: false, error: 'only_owner_can_edit_admin' });
    }
    const valid = await this.prisma.communityRole.findMany({
      where: { serverId, id: { in: roleIds }, isDefault: false },
    });
    const now = Date.now() / 1000;
    const adminRole = await this.prisma.communityRole.findFirst({
      where: { serverId, name: 'Admin', isDefault: false },
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.communityMemberRole.deleteMany({ where: { serverId, userId: targetId } });
      if (valid.length) {
        await tx.communityMemberRole.createMany({
          data: valid.map((r) => ({
            serverId,
            userId: targetId,
            roleId: r.id,
            assignedAt: now,
          })),
        });
      }
      if (adminRole && target.role !== 'owner') {
        const hasAdmin = valid.some((r) => r.id === adminRole.id);
        await tx.communityMember.update({
          where: { serverId_userId: { serverId, userId: targetId } },
          data: { role: hasAdmin ? 'admin' : 'member' },
        });
      }
    });
    return { ok: true as const, role_ids: valid.map((r) => r.id) };
  }

  /** Admin/owner remove outro usuário da sala de voz atual. */
  async disconnectVoiceMember(
    serverId: number,
    actorId: number,
    targetUserId: number,
    channelId?: number,
  ) {
    await this.requirePerm(serverId, actorId, 'members.kick');
    if (targetUserId === actorId) {
      throw new BadRequestException({ ok: false, error: 'cannot_disconnect_self' });
    }
    await this.memberOrThrow(serverId, targetUserId);

    if (channelId) {
      const result = await this.voice.removeParticipant(serverId, channelId, targetUserId);
      await this.presence.setVoiceChannel(serverId, targetUserId, null);
      this.notifyPresence(serverId);
      return { ...result, channel_id: channelId };
    }
    const chId = await this.dropFromVoice(serverId, targetUserId);
    return { ok: true as const, removed: !!chId, channel_id: chId };
  }

  /** Próprio usuário ou admin do servidor atualiza ramal (telefonia). */
  async setUserRamal(
    actorId: number,
    targetId: number,
    ramal: string,
    serverId?: number,
  ) {
    const target = await this.users.findById(targetId);
    if (!target) throw new NotFoundException({ ok: false, error: 'not_found' });
    const actor = await this.users.findById(actorId);
    if (!actor) throw new ForbiddenException({ ok: false, error: 'forbidden' });

    if (actorId !== targetId) {
      const sid = Number(serverId) || 0;
      if (sid <= 0) {
        throw new BadRequestException({ ok: false, error: 'server_required' });
      }
      await this.memberOrThrow(sid, targetId);
      if (actor.role !== 'super_admin') {
        await this.requirePerm(sid, actorId, 'server.manage');
      }
    }

    const updated = await this.users.updateProfile(targetId, {
      ramal: String(ramal || '').trim().slice(0, 32),
    });
    return updated;
  }

  async createJoinRequest(serverId: number, userId: number, message: string) {
    const server = await this.prisma.communityServer.findUnique({ where: { id: serverId } });
    if (!server || !server.isListed) {
      throw new NotFoundException({ ok: false, error: 'not_found' });
    }
    const existing = await this.prisma.communityMember.findUnique({
      where: { serverId_userId: { serverId, userId } },
    });
    if (existing) throw new BadRequestException({ ok: false, error: 'already_member' });
    const pending = await this.prisma.communityJoinRequest.findFirst({
      where: { serverId, userId, status: 'pending' },
    });
    if (pending) return { ok: true as const, request: { id: pending.id, status: pending.status } };
    const req = await this.prisma.communityJoinRequest.create({
      data: {
        serverId,
        userId,
        message: (message || '').slice(0, 500),
        createdAt: Date.now() / 1000,
      },
    });
    return { ok: true as const, request: { id: req.id, status: req.status } };
  }

  async listJoinRequests(userId: number, isSuper: boolean) {
    const adminServers = await this.prisma.communityMember.findMany({
      where: {
        userId,
        role: { in: isSuper ? ['owner', 'admin', 'member'] : ['owner', 'admin'] },
      },
      select: { serverId: true, role: true },
    });
    const serverIds = isSuper
      ? (await this.prisma.communityServer.findMany({ select: { id: true } })).map((s) => s.id)
      : adminServers.filter((m) => m.role !== 'member').map((m) => m.serverId);
    const requests = await this.prisma.communityJoinRequest.findMany({
      where: { serverId: { in: serverIds }, status: 'pending' },
      include: { user: true, server: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return {
      ok: true as const,
      requests: requests.map((r) => ({
        id: r.id,
        server_id: r.serverId,
        server_name: r.server.name,
        message: r.message,
        status: r.status,
        created_at: r.createdAt,
        user: this.users.toPublicUser(r.user),
      })),
    };
  }

  async handleJoinRequest(
    requestId: number,
    userId: number,
    action: 'approve' | 'deny',
    isSuper: boolean,
  ) {
    const req = await this.prisma.communityJoinRequest.findUnique({ where: { id: requestId } });
    if (!req || req.status !== 'pending') {
      throw new NotFoundException({ ok: false, error: 'not_found' });
    }
    const m = await this.prisma.communityMember.findUnique({
      where: { serverId_userId: { serverId: req.serverId, userId } },
    });
    if (!isSuper) {
      if (!m) throw new ForbiddenException({ ok: false, error: 'forbidden' });
      await assertPermission(this.prisma, m, 'join_requests.handle');
    }
    const now = Date.now() / 1000;
    if (action === 'approve') {
      await this.prisma.$transaction([
        this.prisma.communityJoinRequest.update({
          where: { id: requestId },
          data: { status: 'approved', handledBy: userId, handledAt: now },
        }),
        this.prisma.communityMember.upsert({
          where: { serverId_userId: { serverId: req.serverId, userId: req.userId } },
          create: {
            serverId: req.serverId,
            userId: req.userId,
            role: 'member',
            joinedAt: now,
          },
          update: {},
        }),
      ]);
    } else {
      await this.prisma.communityJoinRequest.update({
        where: { id: requestId },
        data: { status: 'denied', handledBy: userId, handledAt: now },
      });
    }
    return { ok: true as const, request: { id: requestId, status: action === 'approve' ? 'approved' : 'denied' } };
  }

  async dmUnread(userId: number) {
    const count = await this.prisma.communityDmMessage.count({
      where: { toUserId: userId, readAt: null },
    });
    return { ok: true as const, count };
  }

  async listDmThreads(userId: number) {
    const msgs = await this.prisma.communityDmMessage.findMany({
      where: { OR: [{ fromUserId: userId }, { toUserId: userId }] },
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: { from: true, to: true, server: true },
    });
    const seen = new Set<string>();
    const threads: Array<{
      other_user: ReturnType<UsersService['toPublicUser']>;
      user: ReturnType<UsersService['toPublicUser']>;
      server_id: number | null;
      server_name: string;
      last_message: string;
      last_body: string;
      last_at: number;
      created_at: number;
      unread: boolean;
    }> = [];
    for (const m of msgs) {
      const otherId = m.fromUserId === userId ? m.toUserId : m.fromUserId;
      const key = `${otherId}:${m.serverId ?? 'null'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const other = m.fromUserId === userId ? m.to : m.from;
      const pub = this.users.toPublicUser(other);
      threads.push({
        other_user: pub,
        user: pub,
        server_id: m.serverId,
        server_name: m.server?.name || '',
        last_message: m.body.slice(0, 200),
        last_body: m.body,
        last_at: m.createdAt,
        created_at: m.createdAt,
        unread: m.toUserId === userId && !m.readAt && m.fromUserId !== userId,
      });
    }
    return { ok: true as const, threads };
  }

  async listDmMessages(userId: number, otherId: number, serverId?: number | null) {
    const rows = await this.prisma.communityDmMessage.findMany({
      where: {
        OR: [
          { fromUserId: userId, toUserId: otherId },
          { fromUserId: otherId, toUserId: userId },
        ],
        ...(serverId ? { serverId } : {}),
      },
      orderBy: { id: 'asc' },
      take: 200,
      include: { from: true },
    });
    await this.prisma.communityDmMessage.updateMany({
      where: {
        fromUserId: otherId,
        toUserId: userId,
        readAt: null,
        ...(serverId ? { serverId } : {}),
      },
      data: { readAt: Date.now() / 1000 },
    });
    return {
      ok: true as const,
      messages: rows.map((r) => ({
        id: r.id,
        body: r.body,
        created_at: r.createdAt,
        from_user_id: r.fromUserId,
        to_user_id: r.toUserId,
        server_id: r.serverId,
        mine: r.fromUserId === userId,
        user: this.users.toPublicUser(r.from),
      })),
    };
  }

  async sendDm(userId: number, otherId: number, body: string, serverId?: number) {
    if (userId === otherId) throw new BadRequestException({ ok: false, error: 'invalid_target' });
    const text = (body || '').trim().slice(0, 4000);
    if (!text) throw new BadRequestException({ ok: false, error: 'empty' });
    const other = await this.users.findById(otherId);
    if (!other) throw new NotFoundException({ ok: false, error: 'not_found' });
    const me = await this.users.findById(userId);
    if (!me) throw new NotFoundException({ ok: false, error: 'not_found' });
    const msg = await this.prisma.communityDmMessage.create({
      data: {
        fromUserId: userId,
        toUserId: otherId,
        serverId: serverId || null,
        body: text,
        createdAt: Date.now() / 1000,
      },
    });
    const fromPub = this.users.toPublicUser(me);
    const dto = {
      id: msg.id,
      body: msg.body,
      created_at: msg.createdAt,
      from_user_id: msg.fromUserId,
      to_user_id: msg.toUserId,
      server_id: msg.serverId,
      user: fromPub,
    };
    this.realtime.emitToUser(otherId, 'dm:new', { ...dto, mine: false });
    return {
      ok: true as const,
      message: {
        ...dto,
        mine: true,
      },
    };
  }

  async invitePreview(code: string, userId?: number) {
    const invite = await this.prisma.communityInvite.findUnique({
      where: { code: (code || '').trim() },
      include: { server: true },
    });
    if (!invite) {
      return { ok: true as const, valid: false as const, reason: 'invalid' };
    }
    if (invite.expiresAt > 0 && invite.expiresAt < Date.now() / 1000) {
      return { ok: true as const, valid: false as const, reason: 'expired' };
    }
    if (invite.maxUses > 0 && invite.uses >= invite.maxUses) {
      return { ok: true as const, valid: false as const, reason: 'exhausted' };
    }
    const memberCount = await this.prisma.communityMember.count({
      where: { serverId: invite.serverId },
    });
    let alreadyMember = false;
    if (userId) {
      const mem = await this.prisma.communityMember.findUnique({
        where: { serverId_userId: { serverId: invite.serverId, userId } },
      });
      alreadyMember = !!mem;
    }
    return {
      ok: true as const,
      valid: true as const,
      code: invite.code,
      already_member: alreadyMember,
      server: {
        id: invite.server.id,
        name: invite.server.name,
        icon_url: invite.server.iconUrl,
        banner_url: invite.server.bannerUrl,
        description: invite.server.description,
        member_count: memberCount,
      },
      invite: {
        code: invite.code,
        server: {
          id: invite.server.id,
          name: invite.server.name,
          icon_url: invite.server.iconUrl,
          banner_url: invite.server.bannerUrl,
          description: invite.server.description,
          member_count: memberCount,
        },
      },
    };
  }

  async adminServers() {
    const servers = await this.prisma.communityServer.findMany({
      orderBy: { id: 'asc' },
      include: {
        owner: true,
        _count: { select: { members: true, channels: true } },
      },
    });
    return {
      ok: true as const,
      servers: servers.map((s) => ({
        id: s.id,
        name: s.name,
        owner_user_id: s.ownerUserId,
        owner_label: s.owner.displayName || s.owner.username,
        owner_username: s.owner.username,
        is_listed: s.isListed,
        is_blocked: s.isBlocked,
        description: s.description,
        members: s._count.members,
        channels: s._count.channels,
        created_at: s.createdAt,
      })),
    };
  }

  async adminPatchServer(
    serverId: number,
    data: { name?: string; is_listed?: boolean; is_blocked?: boolean; description?: string },
  ) {
    const server = await this.prisma.communityServer.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException({ ok: false, error: 'not_found' });
    const updated = await this.prisma.communityServer.update({
      where: { id: serverId },
      data: {
        ...(data.name !== undefined ? { name: data.name.trim().slice(0, 80) } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.is_listed !== undefined ? { isListed: data.is_listed } : {}),
        ...(data.is_blocked !== undefined ? { isBlocked: data.is_blocked } : {}),
      },
    });
    // Bloqueou: todo mundo cai da voz e do socket, e o front sai do servidor
    if (data.is_blocked === true && !server.isBlocked) {
      await this.expelAllMembers(serverId, 'blocked');
    }
    return {
      ok: true as const,
      server: {
        id: updated.id,
        name: updated.name,
        is_listed: updated.isListed,
        is_blocked: updated.isBlocked,
        description: updated.description,
      },
    };
  }

  async adminDeleteServer(serverId: number) {
    const server = await this.prisma.communityServer.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException({ ok: false, error: 'not_found' });
    await this.expelAllMembers(serverId, 'deleted');
    try {
      // Live sessions não têm FK Prisma — limpar antes do delete
      await this.prisma.communityLiveSession.deleteMany({ where: { serverId } });
      await this.prisma.communityServer.delete({ where: { id: serverId } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException({
        ok: false,
        error: 'delete_failed',
        message: msg.slice(0, 400),
      });
    }
    return { ok: true as const };
  }

  async adminDeleteChannel(channelId: number, _actorId: number) {
    const channel = await this.prisma.communityChannel.findUnique({ where: { id: channelId } });
    if (!channel) throw new NotFoundException({ ok: false, error: 'not_found' });
    await this.prisma.communityLiveSession.deleteMany({ where: { channelId } });
    await this.prisma.communityChannel.delete({ where: { id: channelId } });
    return { ok: true as const };
  }

  async adminChannels() {
    const channels = await this.prisma.communityChannel.findMany({
      orderBy: [{ serverId: 'asc' }, { position: 'asc' }],
      include: { server: true },
    });
    return {
      ok: true as const,
      channels: channels.map((c) => ({
        id: c.id,
        server_id: c.serverId,
        server_name: c.server.name,
        name: c.name,
        kind: c.kind,
        position: c.position,
      })),
    };
  }
}


