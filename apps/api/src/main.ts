import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { AppModule } from './app.module';
import { UPLOAD_HEADERS } from './common/upload';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Com REDIS_URL, o Socket.IO compartilha salas entre instâncias (ver redis-io.adapter.ts)
  const redisUrl = (process.env.REDIS_URL || '').trim();
  if (redisUrl) {
    const ioAdapter = new RedisIoAdapter(app);
    if (await ioAdapter.connect(redisUrl)) app.useWebSocketAdapter(ioAdapter);
  }
  // Nginx / reverse proxy — IP real em X-Forwarded-For
  app.set('trust proxy', 1);
  const origin = process.env.CORS_ORIGIN || 'http://127.0.0.1:5173';
  // Cabeçalhos de segurança básicos. CSP fica desligado aqui: o SPA é servido pelo
  // Nginx (produção) ou pelo Vite (dev); a API só responde JSON e /uploads.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
  app.use(cookieParser());
  app.enableCors({
    origin: origin.split(',').map((s) => s.trim()),
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidUnknownValues: false,
    }),
  );
  const uploadRoot = join(process.cwd(), 'uploads');
  if (!existsSync(uploadRoot)) mkdirSync(uploadRoot, { recursive: true });
  app.useStaticAssets(uploadRoot, {
    prefix: '/uploads',
    // Upload nunca vira página: nosniff + CSP sandbox (ver common/upload.ts)
    setHeaders: (res) => {
      for (const [k, v] of Object.entries(UPLOAD_HEADERS)) res.setHeader(k, v);
    },
  });
  const port = Number(process.env.PORT || 8014);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`SteamFarm API listening on :${port}`);
}

bootstrap();
