import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Limite de tentativas de login/registro por (IP, usuário).
 *
 * Só por IP não serve: uma LAN house ou escritório sai pelo mesmo NAT e o desktop faz login
 * automático a cada abertura. Por usuário + IP, quem tem a senha certa nunca esbarra no
 * limite e um ataque de força bruta contra uma conta esbarra em poucas tentativas.
 */
@Injectable()
export class AuthThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const ip = Array.isArray(req.ips) && req.ips.length ? req.ips[0] : req.ip;
    const username = String(req.body?.username || '')
      .toLowerCase()
      .slice(0, 64);
    return `${ip}:${username}`;
  }

  protected async throwThrottlingException(): Promise<void> {
    throw new HttpException({ ok: false, error: 'too_many_attempts' }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
