import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { randomBytes } from 'crypto';
import { CurrentUser, AuthPayload } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { StreamService } from './stream.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class StreamController {
  constructor(private readonly stream: StreamService) {}

  private publicBase() {
    return (
      process.env.PUBLIC_BASE_URL ||
      process.env.PUBLIC_ORIGIN ||
      'http://127.0.0.1:5174'
    ).replace(/\/$/, '');
  }

  @Get('api/community/me/stream-accounts')
  async list(@CurrentUser() user: AuthPayload) {
    const data = await this.stream.listAccounts(user.id);
    return { ok: true, ...data };
  }

  @Post('api/community/me/stream-accounts/manual')
  async manual(
    @CurrentUser() user: AuthPayload,
    @Body() body: { provider?: string; stream_key?: string },
  ) {
    const account = await this.stream.saveManualKey(
      user.id,
      String(body.provider || ''),
      String(body.stream_key || ''),
    );
    return { ok: true, account };
  }

  @Delete('api/community/me/stream-accounts/:provider')
  async unlink(@CurrentUser() user: AuthPayload, @Param('provider') provider: string) {
    await this.stream.unlink(user.id, provider);
    return { ok: true };
  }

  @Get('api/community/stream/oauth/twitch')
  oauthTwitchStart(
    @CurrentUser() user: AuthPayload,
    @Query('next') next: string | undefined,
    @Res() res: Response,
  ) {
    const nxt = (next || '/comunidade').startsWith('/') ? next || '/comunidade' : '/comunidade';
    try {
      const state = this.stream.signOAuthState({
        uid: user.id,
        provider: 'twitch',
        next: nxt,
        nonce: randomBytes(8).toString('hex'),
      });
      return res.redirect(this.stream.twitchAuthorizeUrl(state));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'oauth';
      return res.redirect(`${this.publicBase()}${nxt}?stream=twitch_error&msg=${encodeURIComponent(msg)}`);
    }
  }

  @Public()
  @Get('api/community/stream/oauth/twitch/callback')
  async oauthTwitchCb(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ) {
    let next = '/comunidade';
    try {
      if (error) throw new Error(error);
      if (!code || !state) throw new Error('missing_code');
      const st = this.stream.verifyOAuthState(state);
      next = st.next.startsWith('/') ? st.next : '/comunidade';
      await this.stream.linkTwitchFromCode(st.uid, code);
      return res.redirect(`${this.publicBase()}${next}?stream=twitch_ok`);
    } catch {
      return res.redirect(`${this.publicBase()}${next}?stream=twitch_error`);
    }
  }

  @Get('api/community/stream/oauth/youtube')
  oauthYoutubeStart(
    @CurrentUser() user: AuthPayload,
    @Query('next') next: string | undefined,
    @Res() res: Response,
  ) {
    const nxt = (next || '/comunidade').startsWith('/') ? next || '/comunidade' : '/comunidade';
    try {
      const state = this.stream.signOAuthState({
        uid: user.id,
        provider: 'youtube',
        next: nxt,
        nonce: randomBytes(8).toString('hex'),
      });
      return res.redirect(this.stream.youtubeAuthorizeUrl(state));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'oauth';
      return res.redirect(`${this.publicBase()}${nxt}?stream=youtube_error&msg=${encodeURIComponent(msg)}`);
    }
  }

  @Public()
  @Get('api/community/stream/oauth/youtube/callback')
  async oauthYoutubeCb(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ) {
    let next = '/comunidade';
    try {
      if (error) throw new Error(error);
      if (!code || !state) throw new Error('missing_code');
      const st = this.stream.verifyOAuthState(state);
      next = st.next.startsWith('/') ? st.next : '/comunidade';
      await this.stream.linkYoutubeFromCode(st.uid, code);
      return res.redirect(`${this.publicBase()}${next}?stream=youtube_ok`);
    } catch {
      return res.redirect(`${this.publicBase()}${next}?stream=youtube_error`);
    }
  }
}
