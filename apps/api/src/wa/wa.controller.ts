import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request, Response } from 'express';
import { CurrentUser, AuthPayload } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { WaService } from './wa.service';
import { ZapoClient } from './zapo.client';

@Controller()
@UseGuards(JwtAuthGuard)
export class WaController {
  constructor(
    private readonly wa: WaService,
    private readonly zapo: ZapoClient,
  ) {}

  private slotNum(slot: number) {
    if (slot !== 1 && slot !== 2) {
      throw new BadRequestException({ ok: false, error: 'Slot inválido' });
    }
    return slot;
  }

  private async wrap<T>(fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (e) {
      if (
        e instanceof BadRequestException ||
        (e && typeof e === 'object' && 'getStatus' in e)
      ) {
        throw e;
      }
      throw new BadRequestException({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  @Get('api/community/wa/slots')
  async slots(@CurrentUser() user: AuthPayload) {
    const slots = await this.wa.listSlots(user.id);
    return { ok: true, slots, max: 2 };
  }

  @Post('api/community/wa/slots')
  async createSlot(
    @CurrentUser() user: AuthPayload,
    @Body() body: { slot?: number },
  ) {
    return this.wrap(async () => {
      const slot = body.slot != null ? Number(body.slot) : null;
      const row = await this.wa.ensureSlot(user.id, slot);
      return { ok: true, slot: row };
    });
  }

  @Get('api/community/wa/:slot/status')
  async status(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
  ) {
    return this.wrap(async () => {
      const data = await this.wa.statusSlot(user.id, this.slotNum(slot));
      return { ok: true, ...data };
    });
  }

  @Post('api/community/wa/:slot/pair')
  async pair(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
  ) {
    return this.wrap(async () => {
      await this.wa.ensureSlot(user.id, this.slotNum(slot));
      const data = await this.wa.pairSlot(user.id, this.slotNum(slot));
      return { ok: true, ...data };
    });
  }

  @Post('api/community/wa/:slot/logout')
  async logout(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
  ) {
    return this.wrap(async () => {
      await this.wa.logoutSlot(user.id, this.slotNum(slot));
      return { ok: true };
    });
  }

  @Post('api/community/wa/:slot/crypto')
  async cryptoSetup(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
    @Body() body: { salt?: string; verifier?: string },
  ) {
    return this.wrap(async () => {
      await this.wa.ensureSlot(user.id, this.slotNum(slot));
      const row = await this.wa.setSlotCrypto(
        user.id,
        this.slotNum(slot),
        body.salt || '',
        body.verifier || '',
      );
      return { ok: true, slot: row };
    });
  }

  @Post('api/community/wa/:slot/crypto/unlock')
  async cryptoUnlock(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
    @Body() body: { verifier?: string },
  ) {
    return this.wrap(async () =>
      this.wa.verifySlotCrypto(user.id, this.slotNum(slot), body.verifier || ''),
    );
  }

  @Get('api/community/wa/:slot/archived-groups')
  async archivedGet(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
  ) {
    return this.wrap(async () => ({
      ok: true,
      archived: await this.wa.getArchivedGroups(user.id, this.slotNum(slot)),
    }));
  }

  @Post('api/community/wa/:slot/archived-groups')
  async archivedPost(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
    @Body() body: { jids?: string[]; jid?: string; archived?: boolean },
  ) {
    return this.wrap(async () => {
      const s = this.slotNum(slot);
      if (Array.isArray(body.jids)) {
        return {
          ok: true,
          archived: await this.wa.replaceArchivedGroups(user.id, s, body.jids),
        };
      }
      const jid = String(body.jid || '').trim();
      if (!jid) throw new BadRequestException({ ok: false, error: 'jid obrigatório' });
      return {
        ok: true,
        archived: await this.wa.setArchivedGroup(user.id, s, jid, Boolean(body.archived)),
      };
    });
  }

  @Get('api/community/wa/:slot/chats')
  async chats(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
  ) {
    return this.wrap(async () => {
      const data = await this.wa.proxyJson(user.id, this.slotNum(slot), 'GET', 'chats');
      return typeof data === 'object' && data && !Array.isArray(data)
        ? data
        : { ok: true, chats: data };
    });
  }

  @Get('api/community/wa/:slot/contacts')
  contacts(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
  ) {
    return this.wrap(() => this.wa.proxyJson(user.id, this.slotNum(slot), 'GET', 'contacts'));
  }

  @Get('api/community/wa/:slot/statuses')
  statusesGet(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
  ) {
    return this.wrap(() => this.wa.proxyJson(user.id, this.slotNum(slot), 'GET', 'statuses'));
  }

  @Post('api/community/wa/:slot/statuses')
  statusesPost(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.wrap(() =>
      this.wa.proxyJson(user.id, this.slotNum(slot), 'POST', 'statuses', { payload: body }),
    );
  }

  @Get('api/community/wa/:slot/group')
  group(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
    @Query('jid') jid: string,
  ) {
    return this.wrap(() =>
      this.wa.proxyJson(user.id, this.slotNum(slot), 'GET', 'group', {
        query: `jid=${encodeURIComponent(jid || '')}`,
      }),
    );
  }

  @Get('api/community/wa/:slot/peer')
  peer(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
    @Query('jid') jid: string,
    @Query('refresh') refresh?: string,
  ) {
    return this.wrap(async () => {
      if (!jid) throw new BadRequestException({ ok: false, error: 'jid obrigatório' });
      let q = `jid=${encodeURIComponent(jid)}`;
      if (refresh === '1') q += '&refresh=1';
      return this.wa.proxyJson(user.id, this.slotNum(slot), 'GET', 'peer', {
        query: q,
        timeoutMs: 120_000,
      });
    });
  }

  @Post('api/community/wa/:slot/refresh-groups')
  refreshGroups(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
  ) {
    return this.wrap(() =>
      this.wa.proxyJson(user.id, this.slotNum(slot), 'POST', 'refresh-groups', {
        timeoutMs: 180_000,
      }),
    );
  }

  @Get('api/community/wa/:slot/avatar')
  async avatar(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
    @Query('jid') jid: string,
    @Res() res: Response,
  ) {
    if (!jid) {
      return res.status(400).json({ ok: false, error: 'jid obrigatório' });
    }
    try {
      const sid = await this.wa.requireSessionId(user.id, this.slotNum(slot));
      const { contentType, body } = await this.zapo.sessionBinary(
        sid,
        'avatar',
        `jid=${encodeURIComponent(jid)}`,
        30_000,
      );
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.send(body);
    } catch (e) {
      return res.status(404).json({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  @Post('api/community/wa/:slot/resolve-phone')
  resolvePhone(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.wrap(() =>
      this.wa.proxyJson(user.id, this.slotNum(slot), 'POST', 'resolve-phone', { payload: body }),
    );
  }

  @Post('api/community/wa/:slot/start-chat')
  startChat(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.wrap(() =>
      this.wa.proxyJson(user.id, this.slotNum(slot), 'POST', 'start-chat', { payload: body }),
    );
  }

  @Post('api/community/wa/:slot/clear-chats')
  clearChats(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.wrap(() =>
      this.wa.proxyJson(user.id, this.slotNum(slot), 'POST', 'clear-chats', { payload: body }),
    );
  }

  @Get('api/community/wa/:slot/messages')
  messages(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
    @Query('chatJid') chatJid: string,
    @Query('limit') limit?: string,
    @Query('beforeMs') beforeMs?: string,
  ) {
    return this.wrap(async () => {
      let q = `chatJid=${encodeURIComponent(chatJid || '')}&limit=${encodeURIComponent(limit || '80')}`;
      if (beforeMs) q += `&beforeMs=${encodeURIComponent(beforeMs)}`;
      return this.wa.proxyJson(user.id, this.slotNum(slot), 'GET', 'messages', { query: q });
    });
  }

  @Post('api/community/wa/:slot/read')
  read(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.wrap(() =>
      this.wa.proxyJson(user.id, this.slotNum(slot), 'POST', 'read', { payload: body }),
    );
  }

  @Post('api/community/wa/:slot/send')
  @UseInterceptors(
    FileInterceptor('media', {
      storage: memoryStorage(),
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async send(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.wrap(async () => {
      const s = this.slotNum(slot);
      const ctype = String(req.headers['content-type'] || '');
      if (ctype.includes('multipart/form-data') || file) {
        const sid = await this.wa.requireSessionId(user.id, s);
        const fields: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.body || {})) {
          if (v != null) fields[k] = String(v);
        }
        return this.zapo.sessionSendMultipart(
          sid,
          fields,
          file
            ? {
                filename:
                  String(fields.fileName || file.originalname || 'media').trim() ||
                  'media',
                mimetype: String(
                  fields.mimetype ||
                    fields.mimeType ||
                    file.mimetype ||
                    'application/octet-stream',
                ),
                buffer: file.buffer,
              }
            : null,
        );
      }
      return this.wa.proxyJson(user.id, s, 'POST', 'send', { payload: body });
    });
  }

  @Get('api/community/wa/:slot/media')
  async media(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
    @Query('messageId') messageId: string,
    @Query('chatJid') chatJid: string | undefined,
    @Res() res: Response,
  ) {
    if (!messageId) {
      return res.status(400).json({ ok: false, error: 'messageId obrigatório' });
    }
    try {
      const sid = await this.wa.requireSessionId(user.id, this.slotNum(slot));
      let q = `messageId=${encodeURIComponent(messageId)}`;
      if (chatJid) q += `&chatJid=${encodeURIComponent(chatJid)}`;
      const { contentType, body } = await this.zapo.sessionBinary(sid, 'media', q, 90_000);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-store');
      return res.send(body);
    } catch (e) {
      return res.status(502).json({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  @Post('api/community/wa/:slot/receipt')
  receipt(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.wrap(() =>
      this.wa.proxyJson(user.id, this.slotNum(slot), 'POST', 'receipt', { payload: body }),
    );
  }

  @Post('api/community/wa/:slot/presence')
  presence(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.wrap(() =>
      this.wa.proxyJson(user.id, this.slotNum(slot), 'POST', 'presence', { payload: body }),
    );
  }

  @Get('api/community/wa/:slot/profile')
  profile(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
    @Query('refresh') refresh?: string,
    @Query('force') force?: string,
  ) {
    return this.wrap(() =>
      this.wa.proxyJson(user.id, this.slotNum(slot), 'GET', 'profile', {
        query: refresh === '1' || force === '1' ? 'refresh=1' : '',
        timeoutMs: 90_000,
      }),
    );
  }

  @Post('api/community/wa/:slot/leave-groups')
  leaveGroups(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
    @Body() body: { jids?: string[]; leave?: boolean; deleteChat?: boolean; delete_chat?: boolean },
  ) {
    return this.wrap(() =>
      this.wa.proxyJson(user.id, this.slotNum(slot), 'POST', 'leave-groups', {
        payload: {
          jids: listOf(body.jids),
          leave: body.leave !== false,
          deleteChat: Boolean(body.deleteChat || body.delete_chat),
        },
        timeoutMs: 120_000,
      }),
    );
  }

  @Post('api/community/wa/:slot/invoke')
  invoke(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.wrap(() =>
      this.wa.proxyJson(user.id, this.slotNum(slot), 'POST', 'invoke', { payload: body }),
    );
  }

  @Get('api/community/wa/:slot/events')
  async events(
    @CurrentUser() user: AuthPayload,
    @Param('slot', ParseIntPipe) slot: number,
    @Res() res: Response,
  ) {
    let sid: string;
    try {
      sid = await this.wa.requireSessionId(user.id, this.slotNum(slot));
    } catch (e) {
      return res.status(404).json({
        ok: false,
        error: e instanceof Error ? e.message : 'not_found',
      });
    }
    const url = this.zapo.eventsUrl(sid);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const ctrl = new AbortController();
    reqOnClose(res, () => ctrl.abort());

    try {
      const upstream = await fetch(url, {
        headers: this.zapo.eventsHeaders(),
        signal: ctrl.signal,
      });
      if (!upstream.ok || !upstream.body) {
        res.write(
          `data: ${JSON.stringify({ event: 'error', data: { error: `gateway ${upstream.status}` } })}\n\n`,
        );
        return res.end();
      }
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) res.write(Buffer.from(value));
      }
      return res.end();
    } catch (e) {
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ event: 'error', data: { error: e instanceof Error ? e.message : String(e) } })}\n\n`,
        );
        return res.end();
      }
    }
  }

  @Get('api/community/me/whatsapp')
  async meWhatsappGet(@CurrentUser() user: AuthPayload) {
    const prefs = await this.wa.getUserWhatsapp(user.id);
    return { ok: true, ...prefs };
  }

  @Post('api/community/me/whatsapp')
  async meWhatsappPost(
    @CurrentUser() user: AuthPayload,
    @Body() body: { phone?: string },
  ) {
    const prefs = await this.wa.saveUserWhatsapp(user.id, body.phone || '');
    return { ok: true, ...prefs };
  }
}

function listOf(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

function reqOnClose(res: Response, fn: () => void) {
  res.on('close', fn);
  res.on('finish', fn);
}
