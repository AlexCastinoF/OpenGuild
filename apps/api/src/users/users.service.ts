import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { WORK_STATUS_OPTIONS } from '@steamfarm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { invalidateSessionUser } from '../common/auth-cache';
import type { User } from '@prisma/client';

const ALLOWED = new Set<string>([
  ...WORK_STATUS_OPTIONS.map((o) => o.id),
  'disponivel',
  'available',
]);

/** Paridade com Flask: vazio / disponivel = Disponível. */
function normalizeWorkStatus(value: string | null | undefined): string {
  let raw = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  raw = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (raw === '' || raw === 'disponivel' || raw === 'available') return '';
  if (!ALLOWED.has(raw)) {
    throw new BadRequestException({ ok: false, error: 'Status inválido.' });
  }
  return raw;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: number) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  toAuthUser(
    user: Pick<
      User,
      'id' | 'username' | 'displayName' | 'avatarUrl' | 'role' | 'premiumThemes'
    >,
  ) {
    return {
      id: user.id,
      username: user.username,
      label: user.displayName || user.username,
      avatar_url: user.avatarUrl || '',
      is_super: user.role === 'super_admin',
      premium_themes: !!user.premiumThemes || user.role === 'super_admin',
    };
  }

  toPublicUser(user: User) {
    const showcase = Array.isArray(user.showcaseItems)
      ? (user.showcaseItems as unknown[])
      : [];
    return {
      id: user.id,
      username: user.username,
      label: user.displayName || user.username,
      avatar_url: user.avatarUrl || user.steamAvatar || '',
      ramal: user.ramal || '',
      work_status: user.workStatus || '',
      steam_linked: !!(user.steamId64 || '').trim(),
      steam_id64: user.steamId64 || '',
      steam_persona: user.steamPersona || '',
      showcase_items: showcase.slice(0, 5),
    };
  }

  async setWorkStatus(userId: number, status: string) {
    const normalized = normalizeWorkStatus(status);
    const now = Date.now() / 1000;
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        workStatus: normalized,
        workStatusChangedAt: normalized ? now : 0,
      },
    });
    const opt = WORK_STATUS_OPTIONS.find((o) => o.id === normalized);
    return {
      ok: true as const,
      work_status: user.workStatus || '',
      work_status_since: normalized ? user.workStatusChangedAt || now : 0,
      label: opt?.label || 'Disponível',
      options: WORK_STATUS_OPTIONS.map((o) => ({ id: o.id, label: o.label })),
    };
  }

  async updateProfile(
    userId: number,
    data: {
      display_name?: string;
      ramal?: string;
      avatar_url?: string;
      password?: string;
    },
  ) {
    const patch: Record<string, unknown> = {
      displayName: data.display_name ?? undefined,
      ramal: data.ramal ?? undefined,
      avatarUrl: data.avatar_url ?? undefined,
    };
    if (data.password && data.password.length >= 6) {
      const bcrypt = await import('bcryptjs');
      patch.passwordHash = await bcrypt.hash(data.password, 10);
      // Derruba as outras sessões: o guard compara `tv` do token com tokenVersion
      patch.tokenVersion = { increment: 1 };
    }
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: patch,
    });
    invalidateSessionUser(userId);
    return { ok: true as const, user: this.toPublicUser(user) };
  }

  async getProfile(userId: number) {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException({ ok: false, error: 'not_found' });
    return { ok: true as const, user: this.toPublicUser(user) };
  }
}
