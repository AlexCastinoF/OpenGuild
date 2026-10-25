import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const OPENID_LOGIN = 'https://steamcommunity.com/openid/login';
const STEAM_ID_RE = /https?:\/\/steamcommunity\.com\/openid\/id\/(\d+)/i;
const TRADE_URL_RE =
  /https?:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=(\d+)&token=([A-Za-z0-9_-]+)/i;
const MAX_SHOWCASE = 5;

export type SteamItem = {
  assetid: string;
  classid: string;
  instanceid: string;
  name: string;
  market_hash_name: string;
  icon: string;
  icon_large: string;
  rarity: string;
  rarity_color: string;
  exterior: string;
  type: string;
  quality?: string;
  weapon?: string;
  market_url: string;
  inspect_url?: string;
  contextid: string;
  appid: number;
  amount: number;
  provenance?: string[];
  acquired_hint?: string;
  float_value?: string;
};

@Injectable()
export class SteamService {
  private readonly log = new Logger(SteamService.name);
  private invCache = new Map<string, { at: number; data: { ok: boolean; items: SteamItem[]; message?: string; steamid: string; total?: number; error?: string } }>();

  constructor(private readonly prisma: PrismaService) {}

  steamPublicProfile(user: {
    id: number;
    steamId64: string;
    steamPersona: string;
    steamAvatar: string;
    steamTradeUrl: string;
    showcaseItems: unknown;
    avatarUrl?: string;
    displayName?: string;
    username?: string;
  }) {
    const linked = !!(user.steamId64 || '').trim();
    const showcase = Array.isArray(user.showcaseItems)
      ? (user.showcaseItems as SteamItem[]).slice(0, MAX_SHOWCASE)
      : [];
    return {
      steam_linked: linked,
      steam_id64: user.steamId64 || '',
      steam_persona: user.steamPersona || '',
      steam_avatar: user.steamAvatar || '',
      has_trade_url: !!(user.steamTradeUrl || '').trim(),
      steam_trade_url: user.steamTradeUrl || '',
      steam_profile_url: linked
        ? `https://steamcommunity.com/profiles/${user.steamId64}`
        : '',
      showcase_items: showcase,
    };
  }

  buildOpenIdLoginUrl(returnTo: string, realm: string) {
    const params = new URLSearchParams({
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.mode': 'checkid_setup',
      'openid.return_to': returnTo,
      'openid.realm': realm,
      'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
    });
    return `${OPENID_LOGIN}?${params.toString()}`;
  }

  async verifyOpenId(args: Record<string, string>): Promise<string> {
    const claimed = String(args['openid.claimed_id'] || '');
    const m = claimed.match(STEAM_ID_RE);
    if (!m) throw new BadRequestException({ ok: false, error: 'openid_no_steamid' });
    if (String(args['openid.mode'] || '') !== 'id_res') {
      throw new BadRequestException({ ok: false, error: 'openid_mode' });
    }
    const payload = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) {
      if (k.startsWith('openid.')) payload.set(k, v);
    }
    payload.set('openid.mode', 'check_authentication');
    const res = await fetch(OPENID_LOGIN, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'SteamFarmReact/1.0',
      },
      body: payload.toString(),
    });
    const text = await res.text();
    if (!/is_valid\s*:\s*true/i.test(text)) {
      throw new BadRequestException({ ok: false, error: 'openid_invalid' });
    }
    return m[1];
  }

  parseTradeUrl(raw: string) {
    const m = String(raw || '').trim().match(TRADE_URL_RE);
    if (!m) {
      throw new BadRequestException({
        ok: false,
        error: 'trade_url_invalid',
        message:
          "Trade URL inválida. Cole o link de Steam → Inventário → Troca → 'Quem pode me enviar ofertas?'",
      });
    }
    const partner = m[1];
    const token = m[2];
    const url = `https://steamcommunity.com/tradeoffer/new/?partner=${partner}&token=${token}`;
    return { partner, token, url };
  }

  steamid64ToAccountId(steamid64: string) {
    return Number(BigInt(steamid64) - 76561197960265728n);
  }

  async fetchPersona(steamid64: string): Promise<{ persona: string; avatar: string }> {
    try {
      const url = `https://steamcommunity.com/profiles/${steamid64}/?xml=1`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'SteamFarmReact/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      const xml = await res.text();
      const persona = xml.match(/<steamID><!\[CDATA\[(.*?)\]\]><\/steamID>/i)?.[1]
        || xml.match(/<steamID>([^<]+)<\/steamID>/i)?.[1]
        || '';
      const avatar = xml.match(/<avatarFull><!\[CDATA\[(.*?)\]\]><\/avatarFull>/i)?.[1]
        || xml.match(/<avatarFull>([^<]+)<\/avatarFull>/i)?.[1]
        || '';
      return { persona: persona.trim(), avatar: avatar.trim() };
    } catch (e) {
      this.log.warn(`persona ${steamid64}: ${(e as Error).message}`);
      return { persona: '', avatar: '' };
    }
  }

  async fetchInventory(steamid64: string, force = false) {
    const sid = String(steamid64 || '').trim();
    if (!/^\d{17}$/.test(sid)) {
      return { ok: false as const, error: 'steamid_invalid', items: [] as SteamItem[], steamid: sid };
    }
    const now = Date.now();
    const cached = this.invCache.get(sid);
    if (cached && !force && now - cached.at < 180_000) return cached.data;

    try {
      const url = `https://steamcommunity.com/inventory/${sid}/730/2?l=brazilian&count=2000`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'SteamFarmReact/1.0' },
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) {
        const out = {
          ok: false as const,
          error: 'private_or_empty',
          message:
            'Inventário indisponível. Deixe o inventário CS2 público nas configurações da Steam.',
          items: [] as SteamItem[],
          steamid: sid,
        };
        this.invCache.set(sid, { at: now, data: out });
        return out;
      }
      const raw = (await res.json()) as {
        success?: number;
        assets?: Array<{ assetid: string; classid: string; instanceid: string; amount?: string; contextid?: string }>;
        descriptions?: Array<Record<string, unknown>>;
      };
      if (!raw.success) {
        const out = {
          ok: false as const,
          error: 'private_or_empty',
          message:
            'Inventário indisponível. Deixe o inventário CS2 público nas configurações da Steam.',
          items: [] as SteamItem[],
          steamid: sid,
        };
        this.invCache.set(sid, { at: now, data: out });
        return out;
      }
      const descMap = new Map<string, Record<string, unknown>>();
      for (const d of raw.descriptions || []) {
        descMap.set(`${d.classid}_${d.instanceid}`, d);
      }
      const items: SteamItem[] = [];
      for (const a of raw.assets || []) {
        const d = descMap.get(`${a.classid}_${a.instanceid}`) || {};
        const iconPath = String(d.icon_url_large || d.icon_url || '');
        const icon = iconPath
          ? `https://community.cloudflare.steamstatic.com/economy/image/${iconPath}`
          : '';
        const tags =
          (d.tags as Array<{
            category?: string;
            localized_tag_name?: string;
            name?: string;
            color?: string;
          }>) || [];
        const tag = (cat: string) =>
          tags.find((t) => String(t.category || '').toLowerCase() === cat.toLowerCase());
        const rarityTag = tag('Rarity');
        const exteriorTag = tag('Exterior') || tag('WearCategory');
        const typeTag = tag('Type');
        const qualityTag = tag('Quality');
        const weaponTag = tag('Weapon');
        const marketHash = String(d.market_hash_name || d.name || '');
        let inspectUrl = '';
        for (const action of (d.actions as Array<{ link?: string }>) || []) {
          if (action?.link) {
            inspectUrl = String(action.link).replace('%assetid%', String(a.assetid));
            break;
          }
        }
        const provenance: string[] = [];
        for (const block of (d.owner_descriptions as Array<{ value?: string }>) || []) {
          const val = String(block?.value || '').trim();
          if (val) provenance.push(val);
        }
        for (const block of (d.descriptions as Array<{ value?: string }>) || []) {
          const val = String(block?.value || '').trim();
          if (val && !provenance.includes(val)) provenance.push(val);
        }
        let acquiredHint = '';
        for (const line of provenance) {
          if (
            /\d{1,2}\s+\w+\s+\d{4}|\d{4}-\d{2}-\d{2}|obtido|received|dropped|trade/i.test(line)
          ) {
            acquiredHint = line.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            break;
          }
        }
        items.push({
          assetid: String(a.assetid),
          classid: String(a.classid),
          instanceid: String(a.instanceid),
          name: String(d.name || marketHash),
          market_hash_name: marketHash,
          icon,
          icon_large: icon,
          rarity: String(rarityTag?.localized_tag_name || rarityTag?.name || ''),
          rarity_color: rarityTag?.color ? `#${rarityTag.color}` : '#8b9bb4',
          exterior: String(exteriorTag?.localized_tag_name || exteriorTag?.name || ''),
          type: String(typeTag?.localized_tag_name || typeTag?.name || d.type || ''),
          quality: String(qualityTag?.localized_tag_name || qualityTag?.name || ''),
          weapon: String(weaponTag?.localized_tag_name || weaponTag?.name || ''),
          market_url: marketHash
            ? `https://steamcommunity.com/market/listings/730/${encodeURIComponent(marketHash)}`
            : '',
          inspect_url: inspectUrl,
          contextid: String(a.contextid || '2'),
          appid: 730,
          amount: Number(a.amount || 1),
          provenance: provenance.slice(0, 16),
          acquired_hint: acquiredHint,
        });
      }
      const out = { ok: true as const, items, steamid: sid, total: items.length };
      this.invCache.set(sid, { at: now, data: out });
      return out;
    } catch (e) {
      this.log.warn(`inventory ${sid}: ${(e as Error).message}`);
      return {
        ok: false as const,
        error: 'fetch_failed',
        message: (e as Error).message,
        items: [] as SteamItem[],
        steamid: sid,
      };
    }
  }

  async me(userId: number) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { ok: true, ...this.steamPublicProfile(user) };
  }

  async link(userId: number, steamId64: string) {
    const sid = String(steamId64).trim();
    if (!/^\d{17}$/.test(sid)) {
      throw new BadRequestException({ ok: false, error: 'steamid_invalid' });
    }
    const other = await this.prisma.user.findFirst({
      where: { steamId64: sid, NOT: { id: userId } },
    });
    if (other) {
      throw new BadRequestException({
        ok: false,
        error: 'steam_taken',
        message: 'Este SteamID já está vinculado a outra conta.',
      });
    }
    const { persona, avatar } = await this.fetchPersona(sid);
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        steamId64: sid,
        steamPersona: persona.slice(0, 128),
        steamAvatar: avatar.slice(0, 500),
        steamLinkedAt: Date.now() / 1000,
        avatarUrl: avatar || undefined,
      },
    });
    return { ok: true, ...this.steamPublicProfile(user) };
  }

  async unlink(userId: number) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        steamId64: '',
        steamPersona: '',
        steamAvatar: '',
        steamTradeUrl: '',
        steamLinkedAt: 0,
        showcaseItems: [],
      },
    });
    return { ok: true, ...this.steamPublicProfile(user) };
  }

  async setTradeUrl(userId: number, tradeUrl: string) {
    const { partner, url } = this.parseTradeUrl(tradeUrl);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.steamId64) {
      throw new BadRequestException({
        ok: false,
        error: 'steam_not_linked',
        message: 'Conecte a Steam antes de salvar a Trade URL.',
      });
    }
    const expected = this.steamid64ToAccountId(user.steamId64);
    if (Number(partner) !== expected) {
      throw new BadRequestException({
        ok: false,
        error: 'trade_url_mismatch',
        message: 'A Trade URL não corresponde à conta Steam vinculada.',
      });
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { steamTradeUrl: url },
    });
    return { ok: true, ...this.steamPublicProfile(updated) };
  }

  async setShowcase(
    userId: number,
    items: Array<{
      assetid?: string;
      name?: string;
      market_hash_name?: string;
      icon?: string;
      icon_large?: string;
      rarity?: string;
      rarity_color?: string;
      exterior?: string;
      type?: string;
      classid?: string;
      instanceid?: string;
      [k: string]: unknown;
    }>,
  ) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.steamId64) {
      throw new BadRequestException({
        ok: false,
        error: 'steam_not_linked',
        message: 'Conecte a Steam primeiro.',
      });
    }
    const wanted = (items || [])
      .map((raw) => String(raw?.assetid || '').trim())
      .filter(Boolean)
      .slice(0, MAX_SHOWCASE);
    // Preferir cache / inventário; se a Steam falhar, usar o payload do cliente (já vinha do inventário na UI)
    let inv = await this.fetchInventory(user.steamId64, false);
    if (!inv.ok || !(inv.items || []).length) {
      inv = await this.fetchInventory(user.steamId64, true);
    }
    const byId = new Map((inv.items || []).map((i) => [String(i.assetid), i]));
    const clientById = new Map(
      (items || [])
        .filter((r) => r?.assetid)
        .map((r) => [String(r.assetid), r] as const),
    );
    const chosen: SteamItem[] = [];
    for (const id of wanted) {
      const hit = byId.get(id);
      if (hit) {
        chosen.push(hit);
        continue;
      }
      const raw = clientById.get(id);
      if (raw?.name || raw?.market_hash_name || raw?.icon) {
        chosen.push({
          assetid: id,
          classid: String(raw.classid || ''),
          instanceid: String(raw.instanceid || ''),
          name: String(raw.name || raw.market_hash_name || id),
          market_hash_name: String(raw.market_hash_name || raw.name || ''),
          icon: String(raw.icon || raw.icon_large || ''),
          icon_large: String(raw.icon_large || raw.icon || ''),
          rarity: String(raw.rarity || ''),
          rarity_color: String(raw.rarity_color || '#8b9bb4'),
          exterior: String(raw.exterior || ''),
          type: String(raw.type || ''),
          market_url: '',
          contextid: '2',
          appid: 730,
          amount: 1,
        });
      }
    }
    if (wanted.length > 0 && chosen.length === 0) {
      throw new BadRequestException({
        ok: false,
        error: 'showcase_items_missing',
        message:
          inv.ok === false
            ? inv.message ||
              'Não foi possível validar o inventário Steam. Tenta «Atualizar inventário» e salvar de novo.'
            : 'Os itens selecionados não aparecem no inventário. Atualiza o inventário e tenta outra vez.',
      });
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { showcaseItems: chosen },
    });
    return { ok: true, ...this.steamPublicProfile(updated), saved: chosen.length };
  }

  async inventoryForUser(targetUserId: number, force = false) {
    const user = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!user?.steamId64) {
      return {
        ok: false,
        error: 'steam_not_linked',
        message: 'Usuário sem Steam vinculada.',
        items: [] as SteamItem[],
        steamid: '',
      };
    }
    return this.fetchInventory(user.steamId64, force);
  }
}
