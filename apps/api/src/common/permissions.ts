import { ForbiddenException } from '@nestjs/common';
import { DEFAULT_ADMIN_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS } from '@steamfarm/shared';
import { PrismaService } from '../prisma/prisma.service';

export type MemberRow = { serverId: number; userId: number; role: string };

/** Tudo que o dono tem; também o que `admin` recebe além dos cargos. */
export const OWNER_PERMISSIONS: readonly string[] = [
  ...DEFAULT_ADMIN_PERMISSIONS,
  'server.delete',
  'channels.reorder',
];
const ADMIN_BASE: readonly string[] = [...DEFAULT_ADMIN_PERMISSIONS, 'channels.reorder'];

/**
 * Permissões efetivas de um membro:
 *  - `owner`: todas;
 *  - `admin`: base de admin (papel legado `CommunityMember.role`) ∪ cargos;
 *  - `member`: cargo `@everyone` do servidor (ou o padrão, se não existir) ∪ cargos atribuídos.
 *
 * O papel legado continua valendo para `admin` de propósito: servidores antigos podem não ter
 * vínculo com o cargo "Admin". Usado pelo `CommunityService` e pelo `LiveService`.
 */
export async function memberPermissions(prisma: PrismaService, m: MemberRow): Promise<Set<string>> {
  if (m.role === 'owner') return new Set(OWNER_PERMISSIONS);
  const [everyone, links] = await Promise.all([
    prisma.communityRole.findFirst({
      where: { serverId: m.serverId, isDefault: true },
      select: { permissions: true },
    }),
    prisma.communityMemberRole.findMany({
      where: { serverId: m.serverId, userId: m.userId },
      select: { role: { select: { permissions: true } } },
    }),
  ]);
  const out = new Set<string>();
  const add = (list: unknown) => {
    if (Array.isArray(list)) for (const p of list) if (typeof p === 'string') out.add(p);
  };
  add(everyone ? everyone.permissions : [...DEFAULT_EVERYONE_PERMISSIONS]);
  if (m.role === 'admin') for (const p of ADMIN_BASE) out.add(p);
  for (const l of links) add(l.role.permissions);
  return out;
}

export async function assertPermission(
  prisma: PrismaService,
  m: MemberRow,
  perm: string,
): Promise<void> {
  const perms = await memberPermissions(prisma, m);
  if (!perms.has(perm)) {
    throw new ForbiddenException({ ok: false, error: 'forbidden', missing_permission: perm });
  }
}
