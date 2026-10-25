import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SteamService, type SteamItem } from './steam.service';

const STATUS_LABEL: Record<string, string> = {
  proposed: 'Proposta',
  ready: 'Pronta (ambos aceitaram)',
  steam_sent: 'Oferta enviada na Steam',
  steam_manual: 'Envio manual na Steam',
  steam_failed: 'Falha na Steam',
  completed: 'Concluída',
  cancelled: 'Cancelada',
  declined: 'Recusada',
};

@Injectable()
export class TradesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly steam: SteamService,
  ) {}

  private briefUser(u: {
    id: number;
    username: string;
    displayName: string;
    avatarUrl: string;
    steamAvatar: string;
  }) {
    return {
      id: u.id,
      username: u.username,
      label: u.displayName || u.username,
      avatar_url: u.avatarUrl || u.steamAvatar || '',
    };
  }

  private tradeDict(
    row: {
      id: number;
      proposerUserId: number;
      partnerUserId: number;
      status: string;
      message: string;
      proposerItems: unknown;
      partnerItems: unknown;
      proposerAccepted: boolean;
      partnerAccepted: boolean;
      senderUserId: number | null;
      steamTradeofferid: string;
      steamOfferUrl: string;
      steamError: string;
      createdAt: number;
      updatedAt: number;
      completedAt: number | null;
      proposer: Parameters<SteamService['steamPublicProfile']>[0] & {
        id: number;
        username: string;
        displayName: string;
        avatarUrl: string;
      };
      partner: Parameters<SteamService['steamPublicProfile']>[0] & {
        id: number;
        username: string;
        displayName: string;
        avatarUrl: string;
      };
    },
  ) {
    return {
      id: row.id,
      proposer_user_id: row.proposerUserId,
      partner_user_id: row.partnerUserId,
      status: row.status,
      status_label: STATUS_LABEL[row.status] || row.status,
      message: row.message || '',
      proposer_items: row.proposerItems,
      partner_items: row.partnerItems,
      proposer_accepted: row.proposerAccepted,
      partner_accepted: row.partnerAccepted,
      sender_user_id: row.senderUserId,
      steam_tradeofferid: row.steamTradeofferid || '',
      steam_offer_url: row.steamOfferUrl || '',
      steam_error: row.steamError || '',
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      completed_at: row.completedAt,
      proposer: this.steam.steamPublicProfile(row.proposer),
      partner: this.steam.steamPublicProfile(row.partner),
      proposer_user: this.briefUser(row.proposer),
      partner_user: this.briefUser(row.partner),
    };
  }

  private async loadTrade(id: number) {
    const row = await this.prisma.communityTrade.findUnique({
      where: { id },
      include: { proposer: true, partner: true },
    });
    if (!row) throw new NotFoundException({ ok: false, error: 'not_found' });
    return row;
  }

  async listMine(userId: number) {
    const rows = await this.prisma.communityTrade.findMany({
      where: {
        OR: [{ proposerUserId: userId }, { partnerUserId: userId }],
      },
      include: { proposer: true, partner: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { ok: true, trades: rows.map((r) => this.tradeDict(r)) };
  }

  async listWith(userId: number, otherId: number) {
    const other = await this.prisma.user.findUnique({ where: { id: otherId } });
    if (!other) throw new NotFoundException({ ok: false, error: 'user_not_found' });
    const rows = await this.prisma.communityTrade.findMany({
      where: {
        OR: [
          { proposerUserId: userId, partnerUserId: otherId },
          { proposerUserId: otherId, partnerUserId: userId },
        ],
      },
      include: { proposer: true, partner: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const counts = { completed: 0, pending: 0, cancelled: 0, total: rows.length };
    for (const t of rows) {
      if (t.status === 'completed') counts.completed += 1;
      else if (['cancelled', 'declined', 'steam_failed'].includes(t.status)) counts.cancelled += 1;
      else counts.pending += 1;
    }
    return {
      ok: true,
      other_user: this.briefUser(other),
      counts,
      trades: rows.map((r) => this.tradeDict(r)),
    };
  }

  async get(tradeId: number, userId: number) {
    const row = await this.loadTrade(tradeId);
    if (row.proposerUserId !== userId && row.partnerUserId !== userId) {
      throw new ForbiddenException({ ok: false, error: 'forbidden' });
    }
    return { ok: true, trade: this.tradeDict(row) };
  }

  private pickItems(
    invItems: SteamItem[],
    assetids: string[],
  ): SteamItem[] {
    const byId = new Map(invItems.map((i) => [i.assetid, i]));
    const out: SteamItem[] = [];
    for (const id of assetids) {
      const hit = byId.get(String(id));
      if (hit) out.push(hit);
    }
    return out;
  }

  async create(
    proposerId: number,
    body: {
      partner_id: number;
      give_assetids?: string[];
      want_assetids?: string[];
      message?: string;
    },
  ) {
    const partnerId = Number(body.partner_id);
    if (!partnerId || partnerId === proposerId) {
      throw new BadRequestException({ ok: false, error: 'partner_invalid' });
    }
    const [proposer, partner] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: proposerId } }),
      this.prisma.user.findUnique({ where: { id: partnerId } }),
    ]);
    if (!partner) throw new NotFoundException({ ok: false, error: 'partner_not_found' });
    if (!proposer.steamId64 || !partner.steamId64) {
      throw new BadRequestException({
        ok: false,
        error: 'steam_required',
        message: 'Ambos precisam ter Steam vinculada.',
      });
    }
    if (!proposer.steamTradeUrl || !partner.steamTradeUrl) {
      throw new BadRequestException({
        ok: false,
        error: 'trade_url_required',
        message: 'Ambos precisam ter Trade URL salva.',
      });
    }
    const [myInv, theirInv] = await Promise.all([
      this.steam.fetchInventory(proposer.steamId64, true),
      this.steam.fetchInventory(partner.steamId64, true),
    ]);
    if (!myInv.ok || !theirInv.ok) {
      throw new BadRequestException({
        ok: false,
        error: 'inventory_unavailable',
        message: 'Inventário público indisponível (seu ou do parceiro).',
      });
    }
    const give = this.pickItems(myInv.items, body.give_assetids || []);
    const want = this.pickItems(theirInv.items, body.want_assetids || []);
    if (!give.length && !want.length) {
      throw new BadRequestException({
        ok: false,
        error: 'empty_trade',
        message: 'Selecione ao menos um item.',
      });
    }
    const now = Date.now() / 1000;
    const row = await this.prisma.communityTrade.create({
      data: {
        proposerUserId: proposerId,
        partnerUserId: partnerId,
        status: 'proposed',
        message: String(body.message || '').slice(0, 500),
        proposerItems: give as unknown as Prisma.InputJsonValue,
        partnerItems: want as unknown as Prisma.InputJsonValue,
        proposerAccepted: true,
        partnerAccepted: false,
        createdAt: now,
        updatedAt: now,
      },
      include: { proposer: true, partner: true },
    });
    return { ok: true, trade: this.tradeDict(row) };
  }

  async accept(tradeId: number, userId: number) {
    const row = await this.loadTrade(tradeId);
    if (row.partnerUserId !== userId) {
      throw new ForbiddenException({ ok: false, error: 'only_partner' });
    }
    if (row.status !== 'proposed') {
      throw new BadRequestException({ ok: false, error: 'bad_status' });
    }
    const now = Date.now() / 1000;
    const updated = await this.prisma.communityTrade.update({
      where: { id: tradeId },
      data: {
        partnerAccepted: true,
        status: 'steam_manual',
        updatedAt: now,
        steamError: '',
      },
      include: { proposer: true, partner: true },
    });
    return {
      ok: true,
      trade: this.tradeDict(updated),
      mode: 'manual',
      hint: 'Troca aceita no app. Conclua a oferta na Steam (Trade URL do parceiro) e marque como concluída.',
    };
  }

  async decline(tradeId: number, userId: number) {
    const row = await this.loadTrade(tradeId);
    if (row.partnerUserId !== userId) {
      throw new ForbiddenException({ ok: false, error: 'only_partner' });
    }
    const updated = await this.prisma.communityTrade.update({
      where: { id: tradeId },
      data: { status: 'declined', updatedAt: Date.now() / 1000 },
      include: { proposer: true, partner: true },
    });
    return { ok: true, trade: this.tradeDict(updated) };
  }

  async cancel(tradeId: number, userId: number) {
    const row = await this.loadTrade(tradeId);
    if (row.proposerUserId !== userId) {
      throw new ForbiddenException({ ok: false, error: 'only_proposer' });
    }
    if (['completed', 'declined', 'cancelled'].includes(row.status)) {
      throw new BadRequestException({ ok: false, error: 'bad_status' });
    }
    const updated = await this.prisma.communityTrade.update({
      where: { id: tradeId },
      data: { status: 'cancelled', updatedAt: Date.now() / 1000 },
      include: { proposer: true, partner: true },
    });
    return { ok: true, trade: this.tradeDict(updated) };
  }

  async complete(tradeId: number, userId: number) {
    const row = await this.loadTrade(tradeId);
    if (row.proposerUserId !== userId && row.partnerUserId !== userId) {
      throw new ForbiddenException({ ok: false, error: 'forbidden' });
    }
    if (!['steam_manual', 'steam_sent', 'ready', 'proposed'].includes(row.status)) {
      throw new BadRequestException({ ok: false, error: 'bad_status' });
    }
    const now = Date.now() / 1000;
    const updated = await this.prisma.communityTrade.update({
      where: { id: tradeId },
      data: { status: 'completed', completedAt: now, updatedAt: now },
      include: { proposer: true, partner: true },
    });
    return { ok: true, trade: this.tradeDict(updated) };
  }
}
