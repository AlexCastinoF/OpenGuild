import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { fernetDecrypt, fernetEncrypt } from '../common/fernet';

const SHARE_RE = /^CSGO(-[A-Za-z0-9]{5}){5}$/;
const AUTH_RE = /^[A-Za-z0-9]{4,5}-[A-Za-z0-9]{4,6}-[A-Za-z0-9]{4,5}$/i;
const HELP_URL =
  'https://help.steampowered.com/pt-br/wizard/HelpWithGameIssue/?appid=730&issueid=128';
const MAX_SYNC_CODES = 3;
const SYNC_SLEEP_MS = 1200;
const USER_COOLDOWN_SEC = 90;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeShareCode(raw: string): string {
  const code = String(raw || '').trim().replace(/\s+/g, '');
  if (!SHARE_RE.test(code)) {
    throw new BadRequestException(
      'Sharecode inválido. Formato: CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx (copie exactamente da Steam).',
    );
  }
  return code;
}

function normalizeAuthCode(raw: string): string {
  const code = String(raw || '').trim().replace(/\s+/g, '');
  if (!AUTH_RE.test(code) && !/^[A-Za-z0-9-]{8,24}$/.test(code)) {
    throw new BadRequestException('Código de autenticação inválido.');
  }
  return code;
}

@Injectable()
export class Cs2Service {
  private readonly log = new Logger(Cs2Service.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private async steamApiKey(): Promise<string> {
    const env = (this.config.get<string>('STEAM_WEB_API_KEY') || '').trim();
    if (env) return env;
    const row = await this.prisma.siteSettings.findUnique({ where: { id: 1 } });
    const enc = row?.steamWebApiKeyEnc || '';
    return fernetDecrypt(enc).trim();
  }

  async authStatus(userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('Usuário não encontrado.');
    const auth = fernetDecrypt(user.cs2MatchAuthEnc || '');
    const known = (user.cs2MatchKnownCode || '').trim();
    const shares = await this.prisma.cs2MatchShare.findMany({
      where: { userId },
      select: { meta: true },
    });
    const withDetail = shares.filter((r) => {
      const detail = (r.meta as { detail?: { match_id?: unknown } } | null)?.detail;
      return !!(detail && detail.match_id);
    }).length;
    const apiKey = !!(await this.steamApiKey());
    return {
      configured: !!(auth && known),
      has_auth: !!auth,
      has_known_code: !!known,
      known_code_preview: known ? `${known.slice(0, 12)}…` : '',
      auth_at: user.cs2MatchAuthAt || 0,
      auto_enrich: user.cs2AutoEnrich !== false,
      last_auto_enrich_at: user.cs2LastAutoEnrichAt || 0,
      matches_cached: shares.length,
      matches_with_detail: withDetail,
      steam_linked: !!(user.steamId64 || '').trim(),
      api_key_configured: apiKey,
      help_url: HELP_URL,
      cooldown_sec: USER_COOLDOWN_SEC,
      max_sync_codes: MAX_SYNC_CODES,
    };
  }

  async saveAuth(userId: number, authCode: string, knownCode: string) {
    const auth = normalizeAuthCode(authCode);
    const known = normalizeShareCode(knownCode);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('Usuário não encontrado.');
    if (!(user.steamId64 || '').trim()) {
      throw new BadRequestException('Vincule a Steam no perfil antes.');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        cs2MatchAuthEnc: fernetEncrypt(auth),
        cs2MatchKnownCode: known,
        cs2MatchAuthAt: Date.now() / 1000,
      },
    });
    await this.upsertShare(userId, known, 'seed');
    return { ok: true, status: await this.authStatus(userId) };
  }

  async clearAuth(userId: number) {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        cs2MatchAuthEnc: '',
        cs2MatchKnownCode: '',
        cs2MatchAuthAt: 0,
      },
    });
    return { ok: true, status: await this.authStatus(userId) };
  }

  async setAutoEnrich(userId: number, enabled: boolean) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { cs2AutoEnrich: !!enabled },
    });
    return { ok: true, status: await this.authStatus(userId) };
  }

  private async upsertShare(userId: number, code: string, source: string): Promise<boolean> {
    const existing = await this.prisma.cs2MatchShare.findFirst({
      where: {
        userId,
        shareCode: { equals: code, mode: 'insensitive' },
      },
    });
    if (existing) {
      if (existing.shareCode !== code) {
        await this.prisma.cs2MatchShare.update({
          where: { id: existing.id },
          data: { shareCode: code },
        });
      }
      return false;
    }
    await this.prisma.cs2MatchShare.create({
      data: {
        userId,
        shareCode: code,
        fetchedAt: Date.now() / 1000,
        meta: { source },
      },
    });
    return true;
  }

  private async steamGetNextCode(
    steamid: string,
    auth: string,
    known: string,
    apiKey: string,
  ): Promise<string | null> {
    const params = new URLSearchParams({
      key: apiKey,
      steamid,
      steamidkey: auth,
      knowncode: known,
    });
    const url = `https://api.steampowered.com/ICSGOPlayers_730/GetNextMatchSharingCode/v1/?${params}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SteamFarmReact/1.0' },
      signal: AbortSignal.timeout(20000),
    });
    const raw = await res.text();
    if (res.status === 412) {
      throw new BadRequestException(
        'Steam 412: auth/sharecode rejeitados. Copie de novo os códigos EXATOS (sem mudar maiúsculas).',
      );
    }
    if (!res.ok) {
      throw new BadRequestException(`Steam API ${res.status}: ${raw.slice(0, 200)}`);
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new BadRequestException('Resposta inválida da Steam API.');
    }
    const result = (data.result || data.response || data) as Record<string, unknown>;
    const nested =
      result && typeof result.result === 'object' && result.result
        ? (result.result as Record<string, unknown>)
        : result;
    const code = String(
      (nested && (nested.nextcode || nested.next_code)) || result?.nextcode || '',
    ).trim();
    if (!code || ['N/A', 'NA', 'NONE'].includes(code.toUpperCase())) return null;
    return code;
  }

  /** Sync throttled: max 3 GetNextMatchSharingCode + sleep entre pedidos. */
  async syncCodes(userId: number, maxNew = MAX_SYNC_CODES) {
    const apiKey = await this.steamApiKey();
    if (!apiKey) {
      throw new BadRequestException(
        'Steam Web API key não configurada (admin Flask ou STEAM_WEB_API_KEY).',
      );
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.steamId64) throw new BadRequestException('Steam não vinculada.');
    const auth = fernetDecrypt(user.cs2MatchAuthEnc || '');
    const known = (user.cs2MatchKnownCode || '').trim();
    if (!auth || !known) {
      throw new BadRequestException('Salve o código de autenticação e o sharecode recente primeiro.');
    }

    const seedKnown = known;
    await this.upsertShare(userId, known, 'seed');

    const older = await this.prisma.cs2MatchShare.findMany({
      where: { userId },
      orderBy: { fetchedAt: 'asc' },
      take: 8,
    });
    const cursors = [known];
    for (const o of older) {
      if (!cursors.includes(o.shareCode)) cursors.push(o.shareCode);
    }

    const added: string[] = [];
    let lastError = '';
    const limit = Math.min(MAX_SYNC_CODES, Math.max(1, maxNew));

    for (const start of cursors) {
      try {
        let cursor = start;
        for (let i = 0; i < limit; i++) {
          if (i > 0) await sleep(SYNC_SLEEP_MS);
          const nxt = await this.steamGetNextCode(user.steamId64, auth, cursor, apiKey);
          if (!nxt || nxt === cursor) break;
          const isNew = await this.upsertShare(userId, nxt, 'sync');
          if (isNew) added.push(nxt);
          cursor = nxt;
        }
        lastError = '';
        break;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        if (added.length) break;
      }
    }

    if (seedKnown) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { cs2MatchKnownCode: seedKnown },
      });
    }

    const matches = await this.listMatches(userId);
    if (lastError && !added.length) {
      return {
        ok: false,
        soft: true,
        added: 0,
        new_codes: [] as string[],
        error: lastError,
        status: await this.authStatus(userId),
        matches,
      };
    }
    return {
      ok: true,
      added: added.length,
      new_codes: added,
      status: await this.authStatus(userId),
      matches,
    };
  }

  async listMatches(userId: number) {
    const rows = await this.prisma.cs2MatchShare.findMany({
      where: { userId },
      orderBy: { id: 'desc' },
      take: 40,
    });
    return rows.map((r) => {
      const meta = (r.meta || {}) as Record<string, unknown>;
      const detail = (meta.detail || {}) as Record<string, unknown>;
      const matchtime =
        Number(detail.matchtime || 0) || Number(r.fetchedAt || 0);
      return {
        id: r.id,
        share_code: r.shareCode,
        fetched_at: r.fetchedAt,
        matchtime,
        meta,
        source: meta.source || '',
        detail,
        has_detail: !!(detail && detail.match_id),
        demo_url: String(detail.demo_url || '') || '',
      };
    });
  }

  /** Chama Flask GC enrich (1 partida) — reutiliza Python/steam + sessão TTL. */
  private async flaskEnrich(userId: number, limit = 1) {
    const base = (this.config.get<string>('FLASK_INTERNAL_URL') || '').trim().replace(/\/$/, '');
    const secret = (this.config.get<string>('SF_INTERNAL_SECRET') || '').trim();
    if (!base || !secret) {
      return {
        ok: false,
        skipped: true,
        error:
          'GC enrich indisponível (configure FLASK_INTERNAL_URL + SF_INTERNAL_SECRET no Nest).',
        enriched: 0,
      };
    }
    const res = await fetch(`${base}/api/internal/cs2/enrich`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SteamFarm-Internal': secret,
      },
      body: JSON.stringify({ user_id: userId, limit }),
      signal: AbortSignal.timeout(120000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        enriched: 0,
        error: String(data.error || `Flask enrich HTTP ${res.status}`),
      };
    }
    return data;
  }

  /**
   * Auto-enrich pós-partida GSI: cooldown 90s, sync ≤3, GC enrich 1.
   * Não descarrega .dem — só meta + demo_url.
   */
  async autoEnrich(userId: number, opts?: { force?: boolean; gsi_match?: Record<string, unknown> }) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('Usuário não encontrado.');
    if (user.cs2AutoEnrich === false && !opts?.force) {
      return {
        ok: true,
        skipped: true,
        reason: 'auto_enrich_disabled',
        status: await this.authStatus(userId),
      };
    }
    const now = Date.now() / 1000;
    const last = Number(user.cs2LastAutoEnrichAt || 0);
    if (!opts?.force && last && now - last < USER_COOLDOWN_SEC) {
      return {
        ok: true,
        skipped: true,
        reason: 'cooldown',
        retry_in: Math.ceil(USER_COOLDOWN_SEC - (now - last)),
        status: await this.authStatus(userId),
      };
    }

    const st = await this.authStatus(userId);
    if (!st.configured) {
      return {
        ok: false,
        soft: true,
        error: 'Configure auth + sharecode uma vez no perfil (Histórico CS2).',
        help_url: HELP_URL,
        status: st,
      };
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { cs2LastAutoEnrichAt: now },
    });

    const sync = await this.syncCodes(userId, MAX_SYNC_CODES);
    let enrich: Record<string, unknown> = { ok: true, enriched: 0 };
    try {
      enrich = (await this.flaskEnrich(userId, 1)) as Record<string, unknown>;
    } catch (e) {
      this.log.warn(`flask enrich: ${e}`);
      enrich = {
        ok: false,
        enriched: 0,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    const matches = await this.listMatches(userId);
    const newest = matches.find((m) => m.has_detail) || matches[0] || null;

    return {
      ok: true,
      sync,
      enrich,
      match: newest,
      gsi_hint: opts?.gsi_match || null,
      status: await this.authStatus(userId),
      matches,
    };
  }
}
