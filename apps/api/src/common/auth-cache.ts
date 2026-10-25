import { PrismaService } from '../prisma/prisma.service';

export type SessionUser = {
  id: number;
  username: string;
  role: string;
  tokenVersion: number;
  isDisabled: boolean;
};

/**
 * Cache curto (30 s) do usuário lido pelo `JwtAuthGuard`.
 *
 * O guard passou a consultar o banco a cada requisição para o papel global (`super_admin`),
 * o bloqueio (`isDisabled`) e a versão do token valerem na hora, e não só no próximo login.
 * Sem cache isso seria uma consulta extra por chamada de presença (a cada poll por usuário).
 * Mudou senha, papel ou bloqueio? Chame `invalidateSessionUser`.
 */
const TTL_MS = 30_000;
const cache = new Map<number, { user: SessionUser | null; exp: number }>();

export async function getSessionUser(prisma: PrismaService, id: number): Promise<SessionUser | null> {
  const hit = cache.get(id);
  const now = Date.now();
  if (hit && hit.exp > now) return hit.user;
  const row = await prisma.user.findUnique({
    where: { id },
    select: { id: true, username: true, role: true, tokenVersion: true, isDisabled: true },
  });
  const user = row ? { ...row } : null;
  cache.set(id, { user, exp: now + TTL_MS });
  if (cache.size > 5000) {
    for (const [k, v] of cache) if (v.exp <= now) cache.delete(k);
  }
  return user;
}

export function invalidateSessionUser(id: number) {
  cache.delete(id);
}
