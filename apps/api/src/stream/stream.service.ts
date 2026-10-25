import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { fernetEncrypt } from '../common/fernet';

const PROVIDERS = new Set(['twitch', 'youtube']);
const TWITCH_SCOPES =
  'user:read:email channel:read:stream_key channel:manage:broadcast user:write:chat user:read:chat chat:read chat:edit';
const YOUTUBE_SCOPES = 'https://www.googleapis.com/auth/youtube.force-ssl';
const TWITCH_SCOPES_BROADCAST = new Set(['channel:read:stream_key', 'channel:manage:broadcast']);
const TWITCH_SCOPES_CHAT = new Set(['user:write:chat', 'chat:edit']);

export type StreamAccountPublic = {
  provider: string;
  login: string;
  display_name: string;
  avatar_url: string;
  linked_at: number;
  ready: boolean;
  oauth: boolean;
  manual_key: boolean;
  scopes: string[];
  needs_reconnect: boolean;
  missing_scopes: string[];
  can_manage_broadcast: boolean;
  can_send_chat: boolean;
};

@Injectable()
export class StreamService {
  private readonly log = new Logger(StreamService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  private publicOrigin() {
    return (
      process.env.PUBLIC_BASE_URL ||
      process.env.PUBLIC_ORIGIN ||
      'http://127.0.0.1:5174'
    ).replace(/\/$/, '');
  }

  twitchOAuthConfigured() {
    return !!(process.env.TWITCH_CLIENT_ID || '').trim() && !!(process.env.TWITCH_CLIENT_SECRET || '').trim();
  }

  youtubeOAuthConfigured() {
    return !!(process.env.GOOGLE_CLIENT_ID || '').trim() && !!(process.env.GOOGLE_CLIENT_SECRET || '').trim();
  }

  private parseScopes(raw: string): Set<string> {
    const text = String(raw || '').trim();
    if (!text) return new Set();
    return new Set(text.replace(/,/g, ' ').split(/\s+/).filter(Boolean));
  }

  private toPublic(row: {
    provider: string;
    login: string;
    displayName: string;
    avatarUrl: string;
    linkedAt: number;
    accessTokenEnc: string;
    streamKeyEnc: string;
    scopes: string;
  }): StreamAccountPublic {
    const hasKey = !!(row.streamKeyEnc || '').trim();
    const hasOauth = !!(row.accessTokenEnc || '').trim();
    const ready = hasKey || hasOauth;
    const scopes = this.parseScopes(row.scopes);
    let missingBroadcast: string[] = [];
    let missingChat: string[] = [];
    let needsReconnect = false;
    if (row.provider === 'twitch' && hasOauth) {
      if (!scopes.size) {
        needsReconnect = true;
        missingBroadcast = [...TWITCH_SCOPES_BROADCAST];
        missingChat = [...TWITCH_SCOPES_CHAT];
      } else {
        missingBroadcast = [...TWITCH_SCOPES_BROADCAST].filter((s) => !scopes.has(s));
        if (![...TWITCH_SCOPES_CHAT].some((s) => scopes.has(s))) missingChat = ['user:write:chat'];
        needsReconnect = missingBroadcast.length + missingChat.length > 0;
      }
    }
    const missing = [...missingBroadcast, ...missingChat.filter((s) => !missingBroadcast.includes(s))];
    return {
      provider: row.provider,
      login: row.login || '',
      display_name: row.displayName || row.login || '',
      avatar_url: row.avatarUrl || '',
      linked_at: row.linkedAt || 0,
      ready,
      oauth: hasOauth,
      manual_key: hasKey && !hasOauth,
      scopes: [...scopes].sort(),
      needs_reconnect: needsReconnect,
      missing_scopes: missing,
      can_manage_broadcast: hasOauth ? missingBroadcast.length === 0 : false,
      can_send_chat: hasOauth ? missingChat.length === 0 : false,
    };
  }

  async listAccounts(userId: number) {
    const rows = await this.prisma.userStreamAccount.findMany({ where: { userId } });
    const out: {
      twitch: StreamAccountPublic | null;
      youtube: StreamAccountPublic | null;
      oauth: { twitch: boolean; youtube: boolean };
    } = {
      twitch: null,
      youtube: null,
      oauth: {
        twitch: this.twitchOAuthConfigured(),
        youtube: this.youtubeOAuthConfigured(),
      },
    };
    for (const row of rows) {
      if (row.provider === 'twitch' || row.provider === 'youtube') {
        out[row.provider] = this.toPublic(row);
      }
    }
    return out;
  }

  async saveManualKey(userId: number, providerRaw: string, streamKey: string) {
    const provider = String(providerRaw || '').trim().toLowerCase();
    if (!PROVIDERS.has(provider)) {
      throw new BadRequestException({ ok: false, error: 'provider', message: 'Plataforma inválida.' });
    }
    const key = String(streamKey || '').trim();
    if (key.length < 8) {
      throw new BadRequestException({ ok: false, error: 'stream_key', message: 'Stream key inválida.' });
    }
    const enc = fernetEncrypt(key);
    if (!enc) {
      throw new BadRequestException({
        ok: false,
        error: 'crypto',
        message: 'Não foi possível criptografar a chave (configure ASF_FERNET_KEY_FILE).',
      });
    }
    const now = Date.now() / 1000;
    const row = await this.prisma.userStreamAccount.upsert({
      where: { userId_provider: { userId, provider } },
      create: {
        userId,
        provider,
        streamKeyEnc: enc,
        linkedAt: now,
        login: `manual-${provider}`,
        displayName: 'Chave manual',
      },
      update: {
        streamKeyEnc: enc,
        linkedAt: now,
      },
    });
    return this.toPublic(row);
  }

  async unlink(userId: number, providerRaw: string) {
    const provider = String(providerRaw || '').trim().toLowerCase();
    if (!PROVIDERS.has(provider)) {
      throw new BadRequestException({ ok: false, error: 'provider', message: 'Plataforma inválida.' });
    }
    await this.prisma.userStreamAccount.deleteMany({ where: { userId, provider } });
    return { ok: true as const };
  }

  signOAuthState(payload: { uid: number; provider: string; next: string; nonce: string }) {
    return this.jwt.sign(
      { ...payload, typ: 'stream_oauth' },
      { expiresIn: '15m' },
    );
  }

  verifyOAuthState(token: string) {
    const data = this.jwt.verify(token) as {
      typ?: string;
      uid: number;
      provider: string;
      next: string;
      nonce: string;
    };
    if (data.typ !== 'stream_oauth') throw new Error('state');
    return data;
  }

  twitchAuthorizeUrl(state: string) {
    const cid = (process.env.TWITCH_CLIENT_ID || '').trim();
    if (!cid) throw new BadRequestException({ ok: false, message: 'TWITCH_CLIENT_ID não configurado.' });
    const redirect = `${this.publicOrigin()}/api/community/stream/oauth/twitch/callback`;
    const q = new URLSearchParams({
      client_id: cid,
      redirect_uri: redirect,
      response_type: 'code',
      scope: TWITCH_SCOPES,
      state,
      force_verify: 'true',
    });
    return `https://id.twitch.tv/oauth2/authorize?${q}`;
  }

  youtubeAuthorizeUrl(state: string) {
    const cid = (process.env.GOOGLE_CLIENT_ID || '').trim();
    if (!cid) throw new BadRequestException({ ok: false, message: 'GOOGLE_CLIENT_ID não configurado.' });
    const redirect = `${this.publicOrigin()}/api/community/stream/oauth/youtube/callback`;
    const q = new URLSearchParams({
      client_id: cid,
      redirect_uri: redirect,
      response_type: 'code',
      scope: YOUTUBE_SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }

  async linkTwitchFromCode(userId: number, code: string) {
    const cid = (process.env.TWITCH_CLIENT_ID || '').trim();
    const secret = (process.env.TWITCH_CLIENT_SECRET || '').trim();
    const redirect = `${this.publicOrigin()}/api/community/stream/oauth/twitch/callback`;
    const tokRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cid,
        client_secret: secret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirect,
      }),
    });
    if (!tokRes.ok) throw new BadRequestException({ ok: false, message: 'Falha ao trocar código Twitch.' });
    const tok = (await tokRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      scope?: string[] | string;
      expires_in?: number;
    };
    const access = String(tok.access_token || '');
    const refresh = String(tok.refresh_token || '');
    let scopes = Array.isArray(tok.scope) ? tok.scope.join(' ') : String(tok.scope || TWITCH_SCOPES);
    const meRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: { Authorization: `Bearer ${access}`, 'Client-Id': cid },
    });
    const me = (await meRes.json()) as { data?: Array<Record<string, string>> };
    const u = me.data?.[0];
    if (!u) throw new BadRequestException({ ok: false, message: 'Perfil Twitch indisponível.' });
    try {
      const val = await fetch('https://id.twitch.tv/oauth2/validate', {
        headers: { Authorization: `OAuth ${access}` },
      });
      if (val.ok) {
        const vj = (await val.json()) as { scopes?: string[] };
        if (vj.scopes?.length) scopes = [...vj.scopes].sort().join(' ');
      }
    } catch {
      /* ignore */
    }
    const now = Date.now() / 1000;
    await this.prisma.userStreamAccount.upsert({
      where: { userId_provider: { userId, provider: 'twitch' } },
      create: {
        userId,
        provider: 'twitch',
        providerUserId: String(u.id || ''),
        login: String(u.login || ''),
        displayName: String(u.display_name || u.login || ''),
        avatarUrl: String(u.profile_image_url || ''),
        accessTokenEnc: fernetEncrypt(access),
        refreshTokenEnc: fernetEncrypt(refresh),
        scopes,
        linkedAt: now,
        expiresAt: now + Number(tok.expires_in || 0),
      },
      update: {
        providerUserId: String(u.id || ''),
        login: String(u.login || ''),
        displayName: String(u.display_name || u.login || ''),
        avatarUrl: String(u.profile_image_url || ''),
        accessTokenEnc: fernetEncrypt(access),
        refreshTokenEnc: fernetEncrypt(refresh),
        scopes,
        linkedAt: now,
        expiresAt: now + Number(tok.expires_in || 0),
      },
    });
    this.log.log(`Twitch linked user=${userId} login=${u.login}`);
  }

  async linkYoutubeFromCode(userId: number, code: string) {
    const cid = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const secret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
    const redirect = `${this.publicOrigin()}/api/community/stream/oauth/youtube/callback`;
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cid,
        client_secret: secret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirect,
      }),
    });
    if (!tokRes.ok) throw new BadRequestException({ ok: false, message: 'Falha ao trocar código YouTube.' });
    const tok = (await tokRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    const access = String(tok.access_token || '');
    const refresh = String(tok.refresh_token || '');
    const chRes = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
      { headers: { Authorization: `Bearer ${access}` } },
    );
    const ch = (await chRes.json()) as {
      items?: Array<{ id?: string; snippet?: { title?: string; thumbnails?: { default?: { url?: string } } } }>;
    };
    const item = ch.items?.[0];
    const title = item?.snippet?.title || 'YouTube';
    const avatar = item?.snippet?.thumbnails?.default?.url || '';
    const now = Date.now() / 1000;
    await this.prisma.userStreamAccount.upsert({
      where: { userId_provider: { userId, provider: 'youtube' } },
      create: {
        userId,
        provider: 'youtube',
        providerUserId: String(item?.id || ''),
        login: title,
        displayName: title,
        avatarUrl: avatar,
        accessTokenEnc: fernetEncrypt(access),
        refreshTokenEnc: fernetEncrypt(refresh),
        scopes: YOUTUBE_SCOPES,
        linkedAt: now,
        expiresAt: now + Number(tok.expires_in || 0),
      },
      update: {
        providerUserId: String(item?.id || ''),
        login: title,
        displayName: title,
        avatarUrl: avatar,
        accessTokenEnc: fernetEncrypt(access),
        refreshTokenEnc: refresh ? fernetEncrypt(refresh) : undefined,
        scopes: YOUTUBE_SCOPES,
        linkedAt: now,
        expiresAt: now + Number(tok.expires_in || 0),
      },
    });
    this.log.log(`YouTube linked user=${userId}`);
  }
}
