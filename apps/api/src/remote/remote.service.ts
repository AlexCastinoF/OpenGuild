import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import {
  decryptSessionPassword,
  encryptSessionPassword,
  randomSessionPassword,
} from './remote-crypto';

const PENDING_TTL_MS = 60_000;
const ACTIVE_TTL_MS = 2 * 60 * 60_000;
const AGENT_ONLINE_MS = 3 * 60_000;

export type RemoteDirection = 'control_target' | 'invite_helper';

@Injectable()
export class RemoteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  private now() {
    return Date.now() / 1000;
  }

  private isPremium(user: { role: string; premiumThemes: boolean }) {
    return user.role === 'super_admin' || !!user.premiumThemes;
  }

  private agentOnline(seenAt: number) {
    return seenAt > 0 && this.now() - seenAt < AGENT_ONLINE_MS / 1000;
  }

  /** Confirma que o ID está na BD do hbbs desta instalacao (evita "ID não existe"). */
  private peerRegisteredOnHbbs(rustdeskId: string): boolean | null {
    const id = String(rustdeskId || '').trim();
    if (!/^\d{6,}$/.test(id)) return false;
    const dbPath =
      (process.env.RUSTDESK_DB_PATH || '').trim() || '/opt/rustdesk/data/db_v2.sqlite3';
    if (!existsSync(dbPath)) return null; // dev local: skip
    try {
      const script = `import sqlite3;c=sqlite3.connect(${JSON.stringify(
        dbPath,
      )});r=c.execute("select id from peer where id=?",(${JSON.stringify(
        id,
      )},)).fetchone();print(r[0] if r else "")`;
      const out = execFileSync('python3', ['-c', script], {
        encoding: 'utf8',
        timeout: 4000,
      }).trim();
      return out === id;
    } catch {
      return null;
    }
  }

  getConfig() {
    return {
      ok: true,
      id_server: (process.env.RUSTDESK_ID_SERVER || '').trim(),
      key: (process.env.RUSTDESK_KEY || '').trim(),
      relay_server: (process.env.RUSTDESK_RELAY_SERVER || process.env.RUSTDESK_ID_SERVER || '').trim(),
    };
  }

  private publicSession(s: {
    id: string;
    serverId: number;
    requesterId: number;
    targetId: number;
    direction: string;
    status: string;
    hostUserId: number;
    controllerUserId: number;
    hostRustdeskId: string;
    expiresAt: number;
    createdAt: number;
    updatedAt: number;
    requester?: { id: number; username: string; displayName: string; avatarUrl: string };
    target?: { id: number; username: string; displayName: string; avatarUrl: string };
  }, opts?: { includePassword?: boolean; password?: string }) {
    return {
      ok: true,
      session: {
        id: s.id,
        server_id: s.serverId,
        requester_id: s.requesterId,
        target_id: s.targetId,
        direction: s.direction,
        status: s.status,
        host_user_id: s.hostUserId,
        controller_user_id: s.controllerUserId,
        host_rustdesk_id: s.hostRustdeskId,
        expires_at: s.expiresAt,
        created_at: s.createdAt,
        updated_at: s.updatedAt,
        requester: s.requester
          ? {
              id: s.requester.id,
              username: s.requester.username,
              display_name: s.requester.displayName,
              avatar_url: s.requester.avatarUrl,
            }
          : undefined,
        target: s.target
          ? {
              id: s.target.id,
              username: s.target.username,
              display_name: s.target.displayName,
              avatar_url: s.target.avatarUrl,
            }
          : undefined,
        ...(opts?.includePassword ? { session_password: opts.password || '' } : {}),
      },
      ...(opts?.includePassword ? { session_password: opts.password || '' } : {}),
    };
  }

  async registerAgent(userId: number, rustdeskId: string) {
    const id = String(rustdeskId || '').trim().slice(0, 64);
    if (!id) throw new BadRequestException({ ok: false, error: 'missing_rustdesk_id' });
    const now = this.now();
    await this.prisma.user.update({
      where: { id: userId },
      data: { rustdeskId: id, rustdeskSeenAt: now },
    });
    return { ok: true, rustdesk_id: id, seen_at: now };
  }

  async agentHeartbeat(userId: number) {
    const now = this.now();
    await this.prisma.user.update({
      where: { id: userId },
      data: { rustdeskSeenAt: now },
    });
    return { ok: true, seen_at: now };
  }

  async agentStatus(viewerId: number, userIds: number[]) {
    const ids = [...new Set(userIds.map((n) => Number(n)).filter((n) => n > 0))].slice(0, 100);
    if (!ids.length) return { ok: true, agents: {} as Record<string, { online: boolean; rustdesk_id: string }> };
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, rustdeskId: true, rustdeskSeenAt: true },
    });
    const agents: Record<string, { online: boolean; rustdesk_id: string }> = {};
    for (const u of users) {
      agents[String(u.id)] = {
        online: !!u.rustdeskId && this.agentOnline(u.rustdeskSeenAt),
        // só o próprio viewer vê o ID completo dele; para outros só online
        rustdesk_id: u.id === viewerId ? u.rustdeskId : '',
      };
    }
    return { ok: true, agents };
  }

  async request(opts: {
    requesterId: number;
    serverId: number;
    targetId: number;
    direction: RemoteDirection;
  }) {
    const { requesterId, serverId, targetId, direction } = opts;
    if (requesterId === targetId) {
      throw new BadRequestException({ ok: false, error: 'cannot_remote_self' });
    }
    if (direction !== 'control_target' && direction !== 'invite_helper') {
      throw new BadRequestException({ ok: false, error: 'invalid_direction' });
    }

    const requester = await this.prisma.user.findUnique({ where: { id: requesterId } });
    if (!requester || requester.isDisabled) throw new ForbiddenException({ ok: false, error: 'forbidden' });
    if (!this.isPremium(requester)) {
      throw new ForbiddenException({ ok: false, error: 'premium_required' });
    }

    const [reqMem, tgtMem] = await Promise.all([
      this.prisma.communityMember.findUnique({
        where: { serverId_userId: { serverId, userId: requesterId } },
      }),
      this.prisma.communityMember.findUnique({
        where: { serverId_userId: { serverId, userId: targetId } },
      }),
    ]);
    if (!reqMem || !tgtMem) throw new ForbiddenException({ ok: false, error: 'not_a_member' });

    const target = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!target || target.isDisabled) throw new NotFoundException({ ok: false, error: 'user_not_found' });

    // Expira pendentes antigos do par
    const now = this.now();
    await this.prisma.remoteAccessSession.updateMany({
      where: {
        OR: [
          { requesterId, status: { in: ['pending', 'accepted'] } },
          { targetId: requesterId, status: { in: ['pending', 'accepted', 'active'] } },
          { requesterId: targetId, status: { in: ['pending', 'accepted', 'active'] } },
          { targetId, status: { in: ['pending', 'accepted', 'active'] } },
        ],
        expiresAt: { lt: now },
      },
      data: { status: 'expired', updatedAt: now },
    });

    const busy = await this.prisma.remoteAccessSession.findFirst({
      where: {
        status: { in: ['pending', 'accepted', 'active'] },
        OR: [
          { requesterId },
          { targetId: requesterId },
          { requesterId: targetId },
          { targetId },
        ],
        expiresAt: { gte: now },
      },
    });
    if (busy) throw new BadRequestException({ ok: false, error: 'session_busy' });

    const hostUserId = direction === 'control_target' ? targetId : requesterId;
    const controllerUserId = direction === 'control_target' ? requesterId : targetId;

    const created = await this.prisma.remoteAccessSession.create({
      data: {
        serverId,
        requesterId,
        targetId,
        direction,
        status: 'pending',
        hostUserId,
        controllerUserId,
        expiresAt: now + PENDING_TTL_MS / 1000,
        createdAt: now,
        updatedAt: now,
      },
      include: {
        requester: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        target: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    });

    const payload = this.publicSession(created);
    this.realtime.emitToUser(targetId, 'remote.request', payload);
    this.realtime.emitToUser(requesterId, 'remote.request_sent', payload);

    return {
      ...payload,
      target_agent_online: !!target.rustdeskId && this.agentOnline(target.rustdeskSeenAt),
      host_needs_desktop: true,
    };
  }

  async respond(opts: { sessionId: string; userId: number; accept: boolean }) {
    const { sessionId, userId, accept } = opts;
    const now = this.now();
    const s = await this.prisma.remoteAccessSession.findUnique({
      where: { id: sessionId },
      include: {
        requester: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        target: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    });
    if (!s) throw new NotFoundException({ ok: false, error: 'not_found' });
    if (s.targetId !== userId) throw new ForbiddenException({ ok: false, error: 'not_target' });
    if (s.status !== 'pending') throw new BadRequestException({ ok: false, error: 'not_pending' });
    if (s.expiresAt < now) {
      await this.prisma.remoteAccessSession.update({
        where: { id: s.id },
        data: { status: 'expired', updatedAt: now },
      });
      throw new BadRequestException({ ok: false, error: 'expired' });
    }

    if (!accept) {
      const denied = await this.prisma.remoteAccessSession.update({
        where: { id: s.id },
        data: { status: 'denied', updatedAt: now },
        include: {
          requester: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          target: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        },
      });
      const payload = this.publicSession(denied);
      this.realtime.emitToUser(s.requesterId, 'remote.denied', payload);
      this.realtime.emitToUser(s.targetId, 'remote.denied', payload);
      return payload;
    }

    const password = randomSessionPassword();
    const accepted = await this.prisma.remoteAccessSession.update({
      where: { id: s.id },
      data: {
        status: 'accepted',
        sessionPasswordEnc: encryptSessionPassword(password),
        expiresAt: now + ACTIVE_TTL_MS / 1000,
        updatedAt: now,
      },
      include: {
        requester: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        target: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    });

    const preparePayload = {
      ...this.publicSession(accepted, { includePassword: true, password }),
      role: 'host' as const,
    };
    this.realtime.emitToUser(accepted.hostUserId, 'remote.prepare', preparePayload);
    // controller aguarda remote.ready após host registar ID
    this.realtime.emitToUser(accepted.controllerUserId, 'remote.accepted', this.publicSession(accepted));

    return preparePayload;
  }

  async hostReady(opts: {
    sessionId: string;
    userId: number;
    rustdeskId: string;
    sessionPassword?: string;
  }) {
    const now = this.now();
    const s = await this.prisma.remoteAccessSession.findUnique({
      where: { id: opts.sessionId },
      include: {
        requester: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        target: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    });
    if (!s) throw new NotFoundException({ ok: false, error: 'not_found' });
    if (s.hostUserId !== opts.userId) throw new ForbiddenException({ ok: false, error: 'not_host' });
    if (s.status !== 'accepted' && s.status !== 'active') {
      throw new BadRequestException({ ok: false, error: 'bad_status' });
    }
    const rustdeskId = String(opts.rustdeskId || '').trim();
    if (!rustdeskId) throw new BadRequestException({ ok: false, error: 'missing_rustdesk_id' });

    const registered = this.peerRegisteredOnHbbs(rustdeskId);
    if (registered === false) {
      throw new BadRequestException({
        ok: false,
        error: 'rustdesk_not_on_server',
        message:
          'O RustDesk deste PC ainda não registrou no servidor desta instalacao. Actualize o Desktop, aceite o UAC e confirme ID Server = vps.example.com.',
      });
    }

    let password = '';
    if (opts.sessionPassword) {
      password = String(opts.sessionPassword);
      await this.prisma.remoteAccessSession.update({
        where: { id: s.id },
        data: {
          status: 'active',
          hostRustdeskId: rustdeskId,
          sessionPasswordEnc: encryptSessionPassword(password),
          updatedAt: now,
        },
      });
    } else {
      password = decryptSessionPassword(s.sessionPasswordEnc);
      await this.prisma.remoteAccessSession.update({
        where: { id: s.id },
        data: {
          status: 'active',
          hostRustdeskId: rustdeskId,
          updatedAt: now,
        },
      });
    }

    await this.prisma.user.update({
      where: { id: opts.userId },
      data: { rustdeskId, rustdeskSeenAt: now },
    });

    const updated = await this.prisma.remoteAccessSession.findUnique({
      where: { id: s.id },
      include: {
        requester: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        target: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    });
    if (!updated) throw new NotFoundException({ ok: false, error: 'not_found' });

    const ready = this.publicSession(updated, { includePassword: true, password });
    this.realtime.emitToUser(updated.controllerUserId, 'remote.ready', {
      ...ready,
      role: 'controller',
    });
    this.realtime.emitToUser(updated.hostUserId, 'remote.active', {
      ...this.publicSession(updated),
      role: 'host',
    });
    return ready;
  }

  async end(opts: { sessionId: string; userId: number }) {
    const now = this.now();
    const s = await this.prisma.remoteAccessSession.findUnique({
      where: { id: opts.sessionId },
      include: {
        requester: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        target: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    });
    if (!s) throw new NotFoundException({ ok: false, error: 'not_found' });
    if (s.requesterId !== opts.userId && s.targetId !== opts.userId) {
      throw new ForbiddenException({ ok: false, error: 'forbidden' });
    }
    const ended = await this.prisma.remoteAccessSession.update({
      where: { id: s.id },
      data: {
        status: 'ended',
        sessionPasswordEnc: '',
        updatedAt: now,
      },
      include: {
        requester: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        target: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    });
    const payload = this.publicSession(ended);
    this.realtime.emitToUser(s.requesterId, 'remote.ended', payload);
    this.realtime.emitToUser(s.targetId, 'remote.ended', payload);
    return payload;
  }

  async getActiveForUser(userId: number) {
    const now = this.now();
    const s = await this.prisma.remoteAccessSession.findFirst({
      where: {
        status: { in: ['pending', 'accepted', 'active'] },
        OR: [{ requesterId: userId }, { targetId: userId }],
        expiresAt: { gte: now },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        requester: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        target: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    });
    if (!s) return { ok: true, session: null };
    return this.publicSession(s);
  }
}
