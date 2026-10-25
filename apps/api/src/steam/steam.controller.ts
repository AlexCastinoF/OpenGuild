import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, AuthPayload } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SteamService } from './steam.service';
import { TradesService } from './trades.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class SteamController {
  constructor(
    private readonly steam: SteamService,
    private readonly trades: TradesService,
  ) {}

  private publicBase(req: { headers?: Record<string, string | string[] | undefined>; protocol?: string }) {
    const env = (process.env.PUBLIC_BASE_URL || process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '');
    if (env) return env;
    const host = String(req.headers?.host || '127.0.0.1:8014');
    const proto = String(req.headers?.['x-forwarded-proto'] || 'http');
    return `${proto}://${host}`;
  }

  @Get('steam/link')
  linkStart(
    @CurrentUser() user: AuthPayload,
    @Query('next') next: string | undefined,
    @Req() req: { headers?: Record<string, string | string[] | undefined> },
    @Res() res: Response,
  ) {
    const base = this.publicBase(req);
    const nextPath = (next || '/comunidade').startsWith('/') ? next || '/comunidade' : '/comunidade';
    // /api/... para o return_to — no nginx, /steam/* caía no SPA e o vínculo nunca gravava
    const returnTo = `${base}/api/steam/link/callback?uid=${user.id}&next=${encodeURIComponent(nextPath)}`;
    const url = this.steam.buildOpenIdLoginUrl(returnTo, base);
    return res.redirect(url);
  }

  /** Desktop: devolve a URL OpenID sem 302 (fetch + openExternal). */
  @Get('api/steam/link-url')
  linkUrlJson(
    @CurrentUser() user: AuthPayload,
    @Query('next') next: string | undefined,
    @Req() req: { headers?: Record<string, string | string[] | undefined> },
  ) {
    const base = this.publicBase(req);
    const nextPath = (next || '/comunidade').startsWith('/') ? next || '/comunidade' : '/comunidade';
    const returnTo = `${base}/api/steam/link/callback?uid=${user.id}&next=${encodeURIComponent(nextPath)}`;
    const url = this.steam.buildOpenIdLoginUrl(returnTo, base);
    return { ok: true, url };
  }

  @Public()
  @Get(['steam/link/callback', 'api/steam/link/callback'])
  async linkCallback(
    @Query() query: Record<string, string>,
    @Req() req: { query?: Record<string, unknown> },
    @Res() res: Response,
  ) {
    const raw = { ...(req.query || {}), ...query } as Record<string, string>;
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v == null) continue;
      flat[k] = Array.isArray(v) ? String(v[0]) : String(v);
    }
    const uid = Number(flat.uid || 0);
    const next = String(flat.next || '/comunidade');
    const base = (process.env.PUBLIC_BASE_URL || process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:5174').replace(
      /\/$/,
      '',
    );
    const dest = `${base}${next.startsWith('/') ? next : '/comunidade'}`;
    const desktop = /(?:^|[?&])desktop=1(?:&|$)/.test(next) || next.includes('desktop=1');
    try {
      if (!uid) throw new Error('uid_missing');
      const steamId = await this.steam.verifyOpenId(flat);
      await this.steam.link(uid, steamId);
      if (desktop) {
        return res
          .status(200)
          .type('html')
          .send(this.desktopLinkDoneHtml(true));
      }
      return res.redirect(`${dest}${dest.includes('?') ? '&' : '?'}steam=linked`);
    } catch (e: unknown) {
      let msg = 'steam_link_failed';
      const ex = e as { getResponse?: () => unknown; message?: string };
      const r = typeof ex.getResponse === 'function' ? ex.getResponse() : null;
      if (typeof r === 'string') msg = r;
      else if (r && typeof r === 'object') {
        const o = r as { message?: string | string[]; error?: string };
        if (o.message) msg = Array.isArray(o.message) ? o.message[0] : o.message;
        else if (o.error) msg = o.error;
      } else if (ex.message) msg = ex.message;
      const err = encodeURIComponent(String(msg).slice(0, 180));
      // eslint-disable-next-line no-console
      console.warn('[steam/link/callback]', uid, msg);
      if (desktop) {
        return res
          .status(200)
          .type('html')
          .send(this.desktopLinkDoneHtml(false, String(msg).slice(0, 180)));
      }
      return res.redirect(`${dest}${dest.includes('?') ? '&' : '?'}steam=error&steam_err=${err}`);
    }
  }

  private desktopLinkDoneHtml(ok: boolean, err?: string) {
    const title = ok ? 'Steam ligada' : 'Falha ao ligar Steam';
    const body = ok
      ? 'Conta Steam vinculada. Podes fechar esta janela e voltar à app SteamFarm — o perfil atualiza sozinho.'
      : `Não foi possível vincular: ${err || 'erro'}. Fecha esta janela e tenta outra vez na app.`;
    const color = ok ? '#3dd68c' : '#ff6b6b';
    return `<!DOCTYPE html>
<html lang="pt"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title} · SteamFarm</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Segoe UI,system-ui,sans-serif;
background:#0f1419;color:#e8eef4;padding:1.5rem;text-align:center}
.card{max-width:26rem;padding:1.75rem 1.5rem;border-radius:12px;background:#1a222d;border:1px solid #2a3544}
h1{font-size:1.25rem;margin:0 0 .75rem;color:${color}}
p{margin:0;line-height:1.45;opacity:.92;font-size:.95rem}
</style></head><body><div class="card"><h1>${title}</h1><p>${body}</p></div>
<script>try{localStorage.setItem('sf_steam_link_done','${ok ? '1' : '0'}')}catch(e){}</script>
</body></html>`;
  }

  @Get('api/steam/me')
  me(@CurrentUser() user: AuthPayload) {
    return this.steam.me(user.id);
  }

  @Post('api/steam/unlink')
  unlink(@CurrentUser() user: AuthPayload) {
    return this.steam.unlink(user.id);
  }

  @Put('api/steam/trade-url')
  tradeUrl(@CurrentUser() user: AuthPayload, @Body() body: { trade_url?: string }) {
    return this.steam.setTradeUrl(user.id, String(body.trade_url || ''));
  }

  @Put('api/steam/showcase')
  showcase(
    @CurrentUser() user: AuthPayload,
    @Body() body: { items?: Array<Record<string, unknown> & { assetid?: string }> },
  ) {
    return this.steam.setShowcase(user.id, body.items || []);
  }

  @Get('api/steam/inventory')
  inventory(@CurrentUser() user: AuthPayload, @Query('refresh') refresh?: string) {
    return this.steam.inventoryForUser(user.id, refresh === '1');
  }

  @Get('api/steam/inventory/:userId')
  inventoryUser(
    @Param('userId') userId: string,
    @Query('refresh') refresh?: string,
  ) {
    return this.steam.inventoryForUser(Number(userId), refresh === '1');
  }

  @Get('api/community/trades')
  listTrades(@CurrentUser() user: AuthPayload) {
    return this.trades.listMine(user.id);
  }

  @Get('api/community/trades/with/:otherId')
  listWith(@CurrentUser() user: AuthPayload, @Param('otherId') otherId: string) {
    return this.trades.listWith(user.id, Number(otherId));
  }

  @Post('api/community/trades')
  createTrade(
    @CurrentUser() user: AuthPayload,
    @Body()
    body: {
      partner_id: number;
      give_assetids?: string[];
      want_assetids?: string[];
      message?: string;
    },
  ) {
    return this.trades.create(user.id, body);
  }

  @Get('api/community/trades/:id')
  getTrade(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.trades.get(Number(id), user.id);
  }

  @Post('api/community/trades/:id/accept')
  accept(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.trades.accept(Number(id), user.id);
  }

  @Post('api/community/trades/:id/decline')
  decline(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.trades.decline(Number(id), user.id);
  }

  @Post('api/community/trades/:id/cancel')
  cancel(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.trades.cancel(Number(id), user.id);
  }

  @Post('api/community/trades/:id/complete')
  complete(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.trades.complete(Number(id), user.id);
  }
}
