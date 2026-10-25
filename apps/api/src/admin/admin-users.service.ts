import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { invalidateSessionUser } from '../common/auth-cache';

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
  ) {}

  async list(q?: string) {
    const query = (q || '').trim();
    const rows = await this.prisma.user.findMany({
      where: query
        ? {
            OR: [
              { username: { contains: query, mode: 'insensitive' } },
              { displayName: { contains: query, mode: 'insensitive' } },
            ],
          }
        : undefined,
      orderBy: { id: 'asc' },
      include: {
        memberships: { include: { server: true } },
        theme: true,
      },
      take: 200,
    });
    return {
      ok: true as const,
      users: rows.map((u) => ({
        id: u.id,
        username: u.username,
        label: u.displayName || u.username,
        role: u.role,
        is_super: u.role === 'super_admin',
        premium_themes: !!u.premiumThemes,
        is_disabled: !!u.isDisabled,
        work_status: u.workStatus || '',
        avatar_url: u.avatarUrl || '',
        created_at: u.createdAt,
        has_theme: !!u.theme,
        servers: u.memberships.map((m) => ({
          id: m.serverId,
          name: m.server.name,
          role: m.role,
        })),
      })),
    };
  }

  async patch(
    id: number,
    data: {
      role?: string;
      premium_themes?: boolean;
      is_disabled?: boolean;
      work_status?: string;
      display_name?: string;
      password?: string;
    },
  ) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException({ ok: false, error: 'not_found' });
    if (data.work_status !== undefined) {
      await this.users.setWorkStatus(id, data.work_status);
    }
    const patch: Record<string, unknown> = {};
    if (data.role !== undefined) {
      if (data.role !== 'user' && data.role !== 'super_admin') {
        throw new BadRequestException({ ok: false, error: 'invalid_role' });
      }
      patch.role = data.role;
    }
    if (data.premium_themes !== undefined) patch.premiumThemes = !!data.premium_themes;
    if (data.is_disabled !== undefined) patch.isDisabled = !!data.is_disabled;
    if (data.display_name !== undefined) {
      patch.displayName = String(data.display_name).trim().slice(0, 64);
    }
    if (data.password !== undefined) {
      const pwd = String(data.password || '');
      if (pwd.length < 6) {
        throw new BadRequestException({ ok: false, error: 'password_too_short' });
      }
      if (pwd.length > 128) {
        throw new BadRequestException({ ok: false, error: 'password_too_long' });
      }
      const bcrypt = await import('bcryptjs');
      patch.passwordHash = await bcrypt.hash(pwd, 10);
      // Senha trocada pelo admin derruba as sessões antigas do usuário
      patch.tokenVersion = { increment: 1 };
    }
    const updated =
      Object.keys(patch).length > 0
        ? await this.prisma.user.update({ where: { id }, data: patch })
        : await this.prisma.user.findUniqueOrThrow({ where: { id } });
    // Papel, bloqueio e senha valem na próxima requisição (guard lê do banco, cache 30 s)
    invalidateSessionUser(id);
    if (data.password) {
      console.info(`[admin] password reset for user ${id} (${user.username})`);
    }
    return { ok: true as const, user: this.users.toAuthUser(updated) };
  }

  async remove(id: number, actorId: number) {
    if (id === actorId) {
      throw new BadRequestException({ ok: false, error: 'cannot_delete_self' });
    }
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException({ ok: false, error: 'not_found' });
    await this.prisma.user.delete({ where: { id } });
    console.info(`[admin] user ${actorId} deleted user ${id} (${user.username})`);
    return { ok: true as const };
  }

  async kickFromServer(userId: number, serverId: number) {
    const m = await this.prisma.communityMember.findUnique({
      where: { serverId_userId: { serverId, userId } },
    });
    if (!m) throw new NotFoundException({ ok: false, error: 'not_a_member' });
    if (m.role === 'owner') {
      throw new BadRequestException({ ok: false, error: 'cannot_kick_owner' });
    }
    await this.prisma.communityMember.delete({
      where: { serverId_userId: { serverId, userId } },
    });
    return { ok: true as const };
  }

  async clearTheme(userId: number) {
    await this.prisma.userTheme.deleteMany({ where: { userId } });
    return { ok: true as const };
  }
}
