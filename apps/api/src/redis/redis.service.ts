import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

type MemoryEntry = { value: string; expiresAt: number };

@Injectable()
export class RedisService implements OnModuleDestroy {
  private client: Redis | null = null;
  private memory = new Map<string, MemoryEntry>();
  private readonly useMemory: boolean;

  constructor() {
    const url = process.env.REDIS_URL;
    if (!url) {
      this.useMemory = true;
      return;
    }
    this.useMemory = false;
    this.client = new Redis(url, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    this.client.connect().catch(() => {
      // fallback handled per-call
    });
  }

  async onModuleDestroy() {
    if (this.client) await this.client.quit().catch(() => undefined);
  }

  private purgeMemory() {
    const now = Date.now();
    for (const [k, v] of this.memory) {
      if (v.expiresAt <= now) this.memory.delete(k);
    }
  }

  async setex(key: string, ttlSeconds: number, value: string): Promise<void> {
    if (this.useMemory || !this.client) {
      this.memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
      return;
    }
    try {
      await this.client.setex(key, ttlSeconds, value);
    } catch {
      this.memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    }
  }

  async get(key: string): Promise<string | null> {
    if (this.useMemory || !this.client) {
      this.purgeMemory();
      const hit = this.memory.get(key);
      return hit ? hit.value : null;
    }
    try {
      return await this.client.get(key);
    } catch {
      this.purgeMemory();
      return this.memory.get(key)?.value ?? null;
    }
  }

  async keys(pattern: string): Promise<string[]> {
    if (this.useMemory || !this.client) {
      this.purgeMemory();
      const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return [...this.memory.keys()].filter((k) => re.test(k));
    }
    try {
      return await this.client.keys(pattern);
    } catch {
      this.purgeMemory();
      const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return [...this.memory.keys()].filter((k) => re.test(k));
    }
  }

  async del(key: string): Promise<void> {
    this.memory.delete(key);
    if (this.client) {
      try {
        await this.client.del(key);
      } catch {
        /* ignore */
      }
    }
  }
}
