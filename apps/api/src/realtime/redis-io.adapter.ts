import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

/**
 * Adapter Redis do Socket.IO: com `REDIS_URL`, várias instâncias da API compartilham as salas
 * (`server:<id>`, `user:<id>`), então um `emitToServer` numa instância chega aos sockets das
 * outras. Sem `REDIS_URL` a API continua instância única, como antes.
 */
export class RedisIoAdapter extends IoAdapter {
  private adapterFactory?: ReturnType<typeof createAdapter>;
  private clients: Redis[] = [];

  constructor(app: INestApplicationContext) {
    super(app);
  }

  async connect(url: string): Promise<boolean> {
    const pub = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
    const sub = pub.duplicate();
    try {
      await Promise.all([pub.connect(), sub.connect()]);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[realtime] Redis indisponível para o Socket.IO; seguindo em instância única', err);
      pub.disconnect();
      sub.disconnect();
      return false;
    }
    this.clients = [pub, sub];
    this.adapterFactory = createAdapter(pub, sub);
    return true;
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options);
    if (this.adapterFactory) server.adapter(this.adapterFactory);
    return server;
  }

  async close(server: Server) {
    await Promise.all(this.clients.map((c) => c.quit().catch(() => undefined)));
    return super.close(server);
  }
}
