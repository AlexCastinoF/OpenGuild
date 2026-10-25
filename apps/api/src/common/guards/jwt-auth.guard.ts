import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { getSessionUser } from '../auth-cache';
import type { AuthPayload } from '../decorators/current-user.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest();
    const cookies = (req.cookies || {}) as Record<string, string | undefined>;
    const cookieName = (process.env.AUTH_COOKIE_NAME || 'sf_react_token').trim();
    const header = req.headers?.authorization as string | undefined;
    const token =
      cookies[cookieName] ||
      cookies.sf_react_token ||
      cookies.sf_token ||
      (header?.startsWith('Bearer ') ? header.slice(7) : undefined);

    req.user = undefined;
    if (token) {
      try {
        const payload = this.jwt.verify(token) as AuthPayload & { tv?: number };
        // Papel, bloqueio e versão do token vêm do banco: mudança de papel vale na hora,
        // troca de senha (tokenVersion++) derruba os tokens antigos, usuário apagado ou
        // desativado no admin perde o acesso sem esperar o token expirar.
        const db = await getSessionUser(this.prisma, Number(payload.id));
        if (!db || db.isDisabled || (payload.tv ?? 0) !== db.tokenVersion) {
          throw new Error('session_revoked');
        }
        req.user = { ...payload, id: db.id, username: db.username, role: db.role };
      } catch {
        if (!isPublic) {
          throw new UnauthorizedException({ ok: false, error: 'login_required' });
        }
      }
    } else if (!isPublic) {
      throw new UnauthorizedException({ ok: false, error: 'login_required' });
    }

    return true;
  }
}
