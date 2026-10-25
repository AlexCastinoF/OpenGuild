import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/users.module';
import { AuthThrottlerGuard } from './auth-throttler.guard';

const DEV_SECRET = 'dev-secret-change-me';
const PLACEHOLDERS = new Set([DEV_SECRET, 'change-me-to-a-long-random-string']);

/**
 * Em produção a API se recusa a subir sem um JWT_SECRET de verdade: com o valor padrão
 * qualquer pessoa consegue assinar um token de super admin. O bootstrap da VPS gera um
 * segredo aleatório no .env; em dev, sem a variável, vale o padrão com aviso.
 */
function resolveJwtSecret(): string {
  const raw = (process.env.JWT_SECRET || '').trim();
  const prod = process.env.NODE_ENV === 'production';
  if (prod) {
    if (!raw || raw.length < 32 || PLACEHOLDERS.has(raw)) {
      throw new Error(
        'JWT_SECRET ausente, curto (< 32 caracteres) ou com valor de exemplo. ' +
          'Gere um segredo aleatório no .env antes de iniciar a API em produção.',
      );
    }
    return raw;
  }
  if (!raw) {
    // eslint-disable-next-line no-console
    console.warn('[auth] JWT_SECRET não definido — usando segredo de desenvolvimento.');
    return DEV_SECRET;
  }
  return raw;
}

@Module({
  imports: [
    UsersModule,
    // Só vale nas rotas com AuthThrottlerGuard (login/registro/setup); não é guard global
    // para não limitar o polling de presença/chat, que é frequente por natureza.
    ThrottlerModule.forRoot({
      throttlers: [
        {
          name: 'auth',
          ttl: Number(process.env.AUTH_RATE_TTL_MS || 5 * 60 * 1000),
          limit: Number(process.env.AUTH_RATE_LIMIT || 10),
        },
      ],
    }),
    JwtModule.register({
      global: true,
      secret: resolveJwtSecret(),
      signOptions: { expiresIn: '7d' },
    }),
  ],
  providers: [AuthService, AuthThrottlerGuard],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
