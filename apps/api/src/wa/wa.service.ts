import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ZapoClient } from './zapo.client';

const MAX_SLOTS = 2;

type LiveStatus = {
  meJid?: string;
  pushName?: string;
  status?: string;
  qrPng?: string;
  qr?: string;
  error?: string;
};

@Injectable()
export class WaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly zapo: ZapoClient,
  ) {}

  sessionIdFor(userId: number, slot: number) {
    return `user-${userId}-${slot}`;
  }

  private publicSlot(
    row: {
      id: number;
      slot: number;
      sessionId: string;
      meJid: string;
      pushName: string;
      status: string;
      cryptoSalt: string;
      cryptoVerifier: string;
      createdAt: number;
      updatedAt: number;
    },
    live?: LiveStatus,
  ) {
    const hasCrypto = Boolean((row.cryptoVerifier || '').trim());
    return {
      id: row.id,
      slot: row.slot,
      session_id: row.sessionId,
      me_jid: live?.meJid || row.meJid || '',
      push_name: live?.pushName || row.pushName || '',
      status: live?.status || row.status || 'idle',
      qrPng: live?.qrPng || '',
      qr: live?.qr || '',
      error: live?.error || '',
      has_crypto: hasCrypto,
      crypto_salt: hasCrypto ? row.cryptoSalt || '' : '',
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  async listSlots(userId: number) {
    const rows = await this.prisma.userWaSession.findMany({
      where: { userId },
      orderBy: { slot: 'asc' },
    });
    const out = [];
    for (const row of rows) {
      let live: LiveStatus = {};
      try {
        live = (await this.zapo.sessionRequest('GET', row.sessionId, 'status', {
          timeoutMs: 8_000,
        })) as LiveStatus;
        if (live.meJid || live.status) {
          await this.prisma.userWaSession.update({
            where: { id: row.id },
            data: {
              meJid: live.meJid || row.meJid,
              status: live.status || row.status,
              updatedAt: Date.now() / 1000,
            },
          });
          row.meJid = live.meJid || row.meJid;
          row.status = live.status || row.status;
        }
      } catch {
        live = { status: row.status || 'down', error: 'gateway' };
      }
      out.push(this.publicSlot(row, live));
    }
    return out;
  }

  async ensureSlot(userId: number, slot?: number | null) {
    if (slot != null && slot !== 1 && slot !== 2) {
      throw new BadRequestException({ ok: false, error: 'Slot deve ser 1 ou 2.' });
    }
    const existing = await this.prisma.userWaSession.findMany({ where: { userId } });
    const used = new Set(existing.map((r) => r.slot));
    let target = slot ?? null;
    if (target == null) {
      for (const s of [1, 2]) {
        if (!used.has(s)) {
          target = s;
          break;
        }
      }
      if (target == null) {
        throw new BadRequestException({ ok: false, error: 'Limite de 2 WhatsApps atingido.' });
      }
    } else {
      const found = existing.find((r) => r.slot === target);
      if (found) return this.publicSlot(found);
      if (existing.length >= MAX_SLOTS) {
        throw new BadRequestException({ ok: false, error: 'Limite de 2 WhatsApps atingido.' });
      }
    }
    const now = Date.now() / 1000;
    const row = await this.prisma.userWaSession.create({
      data: {
        userId,
        slot: target,
        sessionId: this.sessionIdFor(userId, target),
        status: 'idle',
        createdAt: now,
        updatedAt: now,
      },
    });
    return this.publicSlot(row);
  }

  async getOwned(userId: number, slot: number) {
    const row = await this.prisma.userWaSession.findFirst({
      where: { userId, slot },
    });
    if (!row) {
      throw new NotFoundException({ ok: false, error: 'Sessão WhatsApp não encontrada.' });
    }
    return row;
  }

  async requireSessionId(userId: number, slot: number) {
    return (await this.getOwned(userId, slot)).sessionId;
  }

  private async syncLive(userId: number, sessionId: string, live: LiveStatus) {
    await this.prisma.userWaSession.updateMany({
      where: { userId, sessionId },
      data: {
        ...(live.meJid ? { meJid: live.meJid } : {}),
        ...(live.pushName ? { pushName: live.pushName } : {}),
        ...(live.status ? { status: live.status } : {}),
        updatedAt: Date.now() / 1000,
      },
    });
  }

  async pairSlot(userId: number, slot: number) {
    const row = await this.getOwned(userId, slot);
    const live = (await this.zapo.sessionRequest('POST', row.sessionId, 'pair', {
      timeoutMs: 30_000,
    })) as LiveStatus;
    await this.syncLive(userId, row.sessionId, live);
    return this.publicSlot(row, live);
  }

  async statusSlot(userId: number, slot: number) {
    const row = await this.getOwned(userId, slot);
    let live: LiveStatus;
    try {
      live = (await this.zapo.sessionRequest('GET', row.sessionId, 'status', {
        timeoutMs: 8_000,
      })) as LiveStatus;
    } catch (e) {
      live = { status: 'down', error: e instanceof Error ? e.message : String(e) };
    }
    await this.syncLive(userId, row.sessionId, live);
    return this.publicSlot(row, live);
  }

  async logoutSlot(userId: number, slot: number) {
    const row = await this.getOwned(userId, slot);
    const meDigits = String(row.meJid || '')
      .split('@')[0]
      .split(':')[0]
      .replace(/\D/g, '');
    try {
      await this.zapo.sessionRequest('POST', row.sessionId, 'clear-chats', {
        payload: { deleteChats: true },
        timeoutMs: 30_000,
      });
    } catch {
      /* ignore */
    }
    try {
      await this.zapo.sessionRequest('POST', row.sessionId, 'logout', { timeoutMs: 20_000 });
    } catch {
      /* ignore */
    }
    await this.prisma.userWaSession.delete({ where: { id: row.id } });
    // Remove vínculo de perfil WhatsApp se era o mesmo número desta sessão
    try {
      const wa = await this.prisma.userWhatsApp.findUnique({ where: { userId } });
      const profileDigits = String(wa?.phone || '').replace(/\D/g, '');
      if (wa && meDigits && profileDigits && profileDigits === meDigits) {
        await this.prisma.userWhatsApp.delete({ where: { userId } });
      } else if (wa && !(await this.prisma.userWaSession.count({ where: { userId } }))) {
        // Sem nenhuma sessão restante — limpa perfil WA do sistema
        await this.prisma.userWhatsApp.delete({ where: { userId } }).catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
  }

  async setSlotCrypto(userId: number, slot: number, salt: string, verifier: string) {
    const s = (salt || '').trim();
    const v = (verifier || '').trim();
    if (s.length < 16 || v.length < 32) {
      throw new BadRequestException({ ok: false, error: 'Senha de criptografia inválida.' });
    }
    await this.getOwned(userId, slot);
    const row = await this.prisma.userWaSession.update({
      where: { userId_slot: { userId, slot } },
      data: { cryptoSalt: s, cryptoVerifier: v, updatedAt: Date.now() / 1000 },
    });
    return this.publicSlot(row);
  }

  async verifySlotCrypto(userId: number, slot: number, verifier: string) {
    const row = await this.getOwned(userId, slot);
    const expected = (row.cryptoVerifier || '').trim();
    if (!expected) return { ok: true, unlocked: true, has_crypto: false };
    if ((verifier || '').trim() !== expected) {
      throw new ForbiddenException({ ok: false, error: 'Senha de descriptografia incorreta.' });
    }
    return { ok: true, unlocked: true, has_crypto: true, salt: row.cryptoSalt || '' };
  }

  private normalizeArchived(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      const jid = String(item || '').trim();
      if (jid && !seen.has(jid)) {
        seen.add(jid);
        out.push(jid);
      }
    }
    return out;
  }

  async getArchivedGroups(userId: number, slot: number) {
    const row = await this.getOwned(userId, slot);
    return this.normalizeArchived(row.archivedGroups);
  }

  async setArchivedGroup(userId: number, slot: number, jid: string, archived: boolean) {
    const jidClean = (jid || '').trim();
    if (!jidClean) throw new BadRequestException({ ok: false, error: 'jid obrigatório' });
    const row = await this.getOwned(userId, slot);
    const current = new Set(this.normalizeArchived(row.archivedGroups));
    if (archived) current.add(jidClean);
    else current.delete(jidClean);
    const archivedGroups = [...current].sort();
    await this.prisma.userWaSession.update({
      where: { id: row.id },
      data: {
        archivedGroups: archivedGroups as unknown as Prisma.InputJsonValue,
        updatedAt: Date.now() / 1000,
      },
    });
    return archivedGroups;
  }

  async replaceArchivedGroups(userId: number, slot: number, jids: string[]) {
    const row = await this.getOwned(userId, slot);
    const archivedGroups = this.normalizeArchived(jids);
    await this.prisma.userWaSession.update({
      where: { id: row.id },
      data: {
        archivedGroups: archivedGroups as unknown as Prisma.InputJsonValue,
        updatedAt: Date.now() / 1000,
      },
    });
    return archivedGroups;
  }

  async proxyJson(
    userId: number,
    slot: number,
    method: string,
    path: string,
    opts?: {
      payload?: Record<string, unknown> | null;
      query?: string;
      timeoutMs?: number;
    },
  ) {
    const sid = await this.requireSessionId(userId, slot);
    return this.zapo.sessionRequest(method, sid, path, opts);
  }

  normalizePhone(raw: string) {
    let digits = (raw || '').replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
    return digits;
  }

  phoneIsValid(raw: string) {
    const digits = this.normalizePhone(raw);
    return (digits.length === 12 || digits.length === 13) && digits.startsWith('55');
  }

  formatPhoneDisplay(raw: string) {
    const digits = this.normalizePhone(raw);
    if (digits.length >= 12 && digits.startsWith('55')) {
      const ddd = digits.slice(2, 4);
      const rest = digits.slice(4);
      if (rest.length === 9) return `+55 (${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}`;
      if (rest.length === 8) return `+55 (${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
    }
    return digits ? `+${digits}` : '';
  }

  async getUserWhatsapp(userId: number) {
    const row = await this.prisma.userWhatsApp.findUnique({ where: { userId } });
    const phone = row?.phone || '';
    return {
      phone,
      enabled: Boolean(row?.enabled),
      events: (row?.events as Record<string, boolean>) || {},
      phone_display: this.formatPhoneDisplay(phone),
    };
  }

  async saveUserWhatsapp(userId: number, phoneRaw: string) {
    const phone = this.normalizePhone(phoneRaw);
    if (phone && !this.phoneIsValid(phone)) {
      throw new BadRequestException({
        ok: false,
        error: 'WhatsApp inválido (use +55 DDD número).',
      });
    }
    const existing = await this.prisma.userWhatsApp.findUnique({ where: { userId } });
    const enabled = Boolean(existing?.enabled) && this.phoneIsValid(phone);
    const events = (existing?.events as Prisma.InputJsonValue) || {};
    const row = await this.prisma.userWhatsApp.upsert({
      where: { userId },
      create: { userId, phone, enabled, events },
      update: { phone, enabled },
    });
    return {
      phone: row.phone,
      enabled: row.enabled,
      events: (row.events as Record<string, boolean>) || {},
      phone_display: this.formatPhoneDisplay(row.phone),
    };
  }
}
