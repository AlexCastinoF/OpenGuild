import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

type CallRow = {
  status?: string;
  origem?: string;
  destino?: string;
  duracao?: number;
};

@Injectable()
export class PabxService {
  private cache: { at: number; data: Awaited<ReturnType<PabxService['fetchFresh']>> } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  private ramalDigits(ramal: string): string {
    let raw = String(ramal || '').trim();
    if (!raw) return '';
    if (raw.includes('-')) raw = raw.split('-').pop() || raw;
    return raw.replace(/\D/g, '') || raw;
  }

  /** Match exato ou sufixo (últimos 4+) quando PABX manda DDI/tronco. */
  private lookupByRamal(
    byDigits: Map<string, Array<{ id: number; ramal: string; displayName: string; username: string }>>,
    key: string,
  ) {
    if (!key) return [] as Array<{ id: number; ramal: string; displayName: string; username: string }>;
    const exact = byDigits.get(key);
    if (exact?.length) return exact;
    const hits: Array<{ id: number; ramal: string; displayName: string; username: string }> = [];
    for (const [digits, users] of byDigits) {
      if (!digits) continue;
      if (key.endsWith(digits) || digits.endsWith(key)) hits.push(...users);
    }
    return hits;
  }

  async getConfig() {
    await this.prisma.siteSettings.upsert({
      where: { id: 1 },
      create: { id: 1, updatedAt: Date.now() / 1000 },
      update: {},
    });
    const s = await this.prisma.siteSettings.findUniqueOrThrow({ where: { id: 1 } });
    const envBase = process.env.PABX_API_BASE || '';
    const envUser = process.env.PABX_USUARIO || '';
    const envToken = process.env.PABX_TOKEN || '';
    const api_base = s.pabxApiBase || envBase;
    const usuario = s.pabxUsuario || envUser;
    const token = s.pabxToken || envToken;
    return {
      api_base,
      usuario,
      token,
      token_set: !!token,
      token_masked: token ? `${token.slice(0, 4)}…${token.slice(-2)}` : '',
      configured: !!(api_base && usuario && token),
    };
  }

  async saveConfig(input: { api_base?: string; usuario?: string; token?: string }) {
    const now = Date.now() / 1000;
    const data: Record<string, unknown> = { updatedAt: now };
    if (input.api_base !== undefined) data.pabxApiBase = input.api_base;
    if (input.usuario !== undefined) data.pabxUsuario = input.usuario;
    if (input.token !== undefined && input.token !== '') data.pabxToken = input.token;
    await this.prisma.siteSettings.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        pabxApiBase: String(input.api_base || ''),
        pabxUsuario: String(input.usuario || ''),
        pabxToken: String(input.token || ''),
        updatedAt: now,
      },
      update: data,
    });
    this.cache = null;
    return this.publicSettings();
  }

  async publicSettings() {
    const cfg = await this.getConfig();
    const test = cfg.configured ? await this.testConnection(cfg) : { ok: false, error: 'not_configured', count: 0 };
    return {
      ok: true as const,
      pabx: {
        api_base: cfg.api_base,
        usuario: cfg.usuario,
        token_set: cfg.token_set,
        token_masked: cfg.token_masked,
        configured: cfg.configured,
      },
      test,
    };
  }

  private async testConnection(cfg: { api_base: string; usuario: string; token: string }) {
    try {
      const calls = await this.fetchCalls(cfg);
      return { ok: true, error: '', count: calls.length };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'error', count: 0 };
    }
  }

  private async fetchCalls(cfg: { api_base: string; usuario: string; token: string }): Promise<CallRow[]> {
    const base = cfg.api_base.replace(/\/$/, '');
    const url = new URL(`${base}/listar_chamadas_online`);
    // Paridade Flask: auth também em query (alguns PABX exigem)
    url.searchParams.set('autenticacao_usuario', cfg.usuario);
    url.searchParams.set('autenticacao_token', cfg.token);
    const res = await fetch(url, {
      headers: {
        usuario: cfg.usuario,
        token: cfg.token,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    // Doc Suite PABX: 404 = nenhuma chamada online
    if (res.status === 404) return [];
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      throw new Error(`pabx_http_${res.status}`);
    }
    // Formato real da API: { dados: [...] } (igual Flask). Aceita também data / array.
    if (Array.isArray(raw)) {
      if (res.status >= 400) {
        const msg =
          raw[0] && typeof raw[0] === 'object'
            ? String(
                (raw[0] as { mensagem?: string; message?: string }).mensagem ||
                  (raw[0] as { message?: string }).message ||
                  '',
              )
            : '';
        throw new Error(msg || `pabx_http_${res.status}`);
      }
      return [];
    }
    if (!raw || typeof raw !== 'object') throw new Error('pabx_formato');
    const obj = raw as {
      dados?: unknown;
      data?: unknown;
      mensagem?: string;
    };
    if (res.status >= 400) {
      throw new Error(String(obj.mensagem || `pabx_http_${res.status}`));
    }
    const rows = Array.isArray(obj.dados)
      ? obj.dados
      : Array.isArray(obj.data)
        ? obj.data
        : [];
    if (!Array.isArray(rows)) throw new Error('pabx_dados_invalidos');
    return rows
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
      .map((row) => ({
        status: String(row.status || '').trim(),
        origem: String(row.origem || '').trim(),
        destino: String(row.destino || '').trim(),
        duracao: Math.max(0, Number(row.duracao) || 0),
      }));
  }

  private async fetchFresh() {
    const cfg = await this.getConfig();
    if (!cfg.configured) {
      return {
        online_calls: [] as CallRow[],
        on_call: {} as Record<string, CallRow & { ramal: string }>,
        pabx: { configured: false, ok: false, error: 'not_configured' },
      };
    }
    try {
      const calls = await this.fetchCalls(cfg);
      const users = await this.prisma.user.findMany({
        where: { ramal: { not: '' } },
        select: { id: true, ramal: true, displayName: true, username: true },
      });
      const byDigits = new Map<string, typeof users>();
      for (const u of users) {
        const d = this.ramalDigits(u.ramal);
        if (!d) continue;
        const list = byDigits.get(d) || [];
        list.push(u);
        byDigits.set(d, list);
      }
      const on_call: Record<string, CallRow & { ramal: string }> = {};
      const enriched = calls.map((c) => {
        const o = this.ramalDigits(String(c.origem || ''));
        const d = this.ramalDigits(String(c.destino || ''));
        const origem_members = this.lookupByRamal(byDigits, o).map((u) => ({
          id: u.id,
          label: u.displayName || u.username,
        }));
        const destino_members = this.lookupByRamal(byDigits, d).map((u) => ({
          id: u.id,
          label: u.displayName || u.username,
        }));
        for (const m of [...origem_members, ...destino_members]) {
          on_call[String(m.id)] = {
            origem: c.origem || '',
            destino: c.destino || '',
            status: c.status || '',
            duracao: Number(c.duracao) || 0,
            ramal: users.find((u) => u.id === m.id)?.ramal || '',
          };
        }
        return { ...c, origem_members, destino_members };
      });
      return {
        online_calls: enriched,
        on_call,
        pabx: { configured: true, ok: true, error: '' },
      };
    } catch (e) {
      return {
        online_calls: [] as CallRow[],
        on_call: {} as Record<string, CallRow & { ramal: string }>,
        pabx: {
          configured: true,
          ok: false,
          error: e instanceof Error ? e.message : 'error',
        },
      };
    }
  }

  async snapshot() {
    const now = Date.now();
    if (this.cache && now - this.cache.at < 3000) return this.cache.data;
    const data = await this.fetchFresh();
    this.cache = { at: now, data };
    return data;
  }
}
