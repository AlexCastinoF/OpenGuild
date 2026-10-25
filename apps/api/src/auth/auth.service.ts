import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  createHash,
  createHmac,
  randomInt,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';

const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;

/** Aceita bcrypt ($2…) e hash Werkzeug/Flask (scrypt:N:r:p$salt$hex). */
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored) return false;
  if (stored.startsWith('$2')) {
    return bcrypt.compare(password, stored);
  }
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const [method, salt, hashHex] = parts;
  if (!method.startsWith('scrypt:')) return false;
  const bits = method.split(':');
  const n = Number(bits[1]);
  const r = Number(bits[2]);
  const p = Number(bits[3]);
  if (![n, r, p].every((v) => Number.isFinite(v) && v > 0)) return false;
  try {
    const key = await new Promise<Buffer>((resolve, reject) => {
      scryptCb(
        password,
        salt,
        64,
        { N: n, r, p, maxmem: 128 * 1024 * 1024 },
        (err, derived) => (err ? reject(err) : resolve(derived as Buffer)),
      );
    });
    const expected = Buffer.from(hashHex, 'hex');
    if (key.length !== expected.length) return false;
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly users: UsersService,
  ) {}

  private captchaPepper() {
    return (
      process.env.CAPTCHA_SECRET ||
      process.env.JWT_SECRET ||
      process.env.AUTH_SECRET ||
      'steamfarm-react-captcha'
    );
  }

  private hashCaptchaAnswer(answer: number) {
    return createHash('sha256')
      .update(`${this.captchaPepper()}|reg|${answer}`)
      .digest('hex');
  }

  createCaptcha() {
    const a = randomInt(2, 12);
    const b = randomInt(1, 10);
    const answer = a + b;
    const captcha_token = this.jwt.sign(
      { typ: 'reg_captcha', h: this.hashCaptchaAnswer(answer) },
      { expiresIn: '10m' },
    );
    return {
      ok: true as const,
      captcha_token,
      question: `Quanto é ${a} + ${b}?`,
    };
  }

  assertCaptcha(token?: string, answerRaw?: string | number) {
    const answer = Number(String(answerRaw ?? '').trim());
    if (!token || !Number.isFinite(answer)) {
      throw new BadRequestException({ ok: false, error: 'Complete o captcha' });
    }
    try {
      const payload = this.jwt.verify(token) as { typ?: string; h?: string };
      if (payload.typ !== 'reg_captcha' || !payload.h) {
        throw new Error('bad typ');
      }
      const expected = Buffer.from(payload.h, 'utf8');
      const got = Buffer.from(this.hashCaptchaAnswer(answer), 'utf8');
      if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
        throw new Error('bad ans');
      }
    } catch {
      throw new BadRequestException({ ok: false, error: 'Captcha inválido ou expirado' });
    }
  }

  async ensureSettings() {
    const now = Date.now() / 1000;
    await this.prisma.siteSettings.upsert({
      where: { id: 1 },
      create: { id: 1, updatedAt: now },
      update: {},
    });
  }

  async status(userId?: number) {
    await this.ensureSettings();
    const settings = await this.prisma.siteSettings.findUnique({ where: { id: 1 } });
    const user = userId ? await this.users.findById(userId) : null;
    return {
      ok: true as const,
      register_enabled: settings?.registerEnabled ?? true,
      logged_in: !!user,
      user: user ? this.users.toAuthUser(user) : null,
      desktop: false,
      needs_setup: (await this.prisma.user.count()) === 0,
    };
  }

  async login(username: string, password: string) {
    const needle = String(username || '').trim();
    const pass = String(password || '');
    let user = needle
      ? await this.prisma.user.findUnique({ where: { username: needle } })
      : null;
    if (!user && needle) {
      const rows = await this.prisma.user.findMany({
        where: { username: { equals: needle, mode: 'insensitive' } },
        take: 2,
      });
      if (rows.length === 1) user = rows[0];
    }
    if (!user || !(await verifyPassword(pass, user.passwordHash))) {
      throw new UnauthorizedException({ ok: false, error: 'Usuário ou senha inválidos' });
    }
    if (user.isDisabled) {
      throw new UnauthorizedException({ ok: false, error: 'Conta desativada' });
    }
    // Não migrar Flask→bcrypt: vps.example.com (Flask) e chat compartilham `users`.
    // verifyPassword já aceita scrypt Werkzeug e bcrypt.
    return this.issue(user);
  }

  async register(input: {
    username: string;
    password: string;
    display_name?: string;
    captcha_token?: string;
    captcha_answer?: string | number;
  }) {
    await this.ensureSettings();
    const settings = await this.prisma.siteSettings.findUnique({ where: { id: 1 } });
    if (!settings?.registerEnabled) {
      throw new BadRequestException({ ok: false, error: 'Registro desabilitado' });
    }
    this.assertCaptcha(input.captcha_token, input.captcha_answer);
    return this.createUser(
      {
        username: input.username,
        password: input.password,
        display_name: input.display_name,
      },
      'admin_client',
    );
  }

  async setup(input: { username: string; password: string; display_name?: string }) {
    if ((await this.prisma.user.count()) > 0) {
      throw new BadRequestException({ ok: false, error: 'Setup já realizado' });
    }
    return this.createUser(input, 'super_admin');
  }

  private async createUser(
    input: { username: string; password: string; display_name?: string },
    role: string,
  ) {
    if (!USERNAME_RE.test(input.username || '')) {
      throw new BadRequestException({ ok: false, error: 'Username inválido' });
    }
    if (!input.password || input.password.length < 6) {
      throw new BadRequestException({ ok: false, error: 'Senha muito curta' });
    }
    const exists = await this.prisma.user.findUnique({ where: { username: input.username } });
    if (exists) throw new BadRequestException({ ok: false, error: 'Username já existe' });
    const passwordHash = await bcrypt.hash(input.password, 10);
    const user = await this.prisma.user.create({
      data: {
        username: input.username,
        passwordHash,
        role,
        displayName: input.display_name || '',
        ramal: '',
        createdAt: Date.now() / 1000,
      },
    });
    return this.issue(user);
  }

  private issue(user: {
    id: number;
    username: string;
    role: string;
    displayName: string;
    avatarUrl: string;
    premiumThemes?: boolean;
    tokenVersion?: number;
  }) {
    // `tv` = User.tokenVersion: trocar a senha incrementa e invalida os tokens anteriores
    const token = this.jwt.sign({
      id: user.id,
      username: user.username,
      role: user.role,
      tv: user.tokenVersion ?? 0,
    });
    return {
      token,
      payload: {
        ok: true as const,
        user: this.users.toAuthUser({
          ...user,
          premiumThemes: user.premiumThemes ?? false,
        }),
        community_url: '/comunidade',
        desktop: false,
      },
    };
  }

  cookieName() {
    return (process.env.AUTH_COOKIE_NAME || 'sf_react_token').trim() || 'sf_react_token';
  }

  desktopCookieName() {
    return (process.env.DESKTOP_COOKIE_NAME || 'sf_react_desktop').trim() || 'sf_react_desktop';
  }

  cookieOptions() {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: process.env.COOKIE_SECURE === 'true',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    };
  }

  /** Segredo partilhado com farmsteam (Flask) para handoff de sessão. */
  bridgeSecret() {
    return (
      process.env.SF_AUTH_BRIDGE_SECRET ||
      process.env.JWT_SECRET ||
      process.env.AUTH_SECRET ||
      ''
    ).trim();
  }

  private b64urlToBuf(s: string) {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
  }

  /** Consome token HMAC do Flask e emite sessão JWT (mesmo user_id do Postgres). */
  async consumeBridgeToken(raw?: string) {
    const token = String(raw || '').trim();
    const secret = this.bridgeSecret();
    if (!token || !secret) {
      throw new UnauthorizedException({ ok: false, error: 'bridge_unavailable' });
    }
    const parts = token.split('.');
    if (parts.length !== 2) {
      throw new UnauthorizedException({ ok: false, error: 'bridge_invalid' });
    }
    const [payloadB64, sigB64] = parts;
    const expected = createHmac('sha256', secret).update(payloadB64).digest();
    let got: Buffer;
    try {
      got = this.b64urlToBuf(sigB64);
    } catch {
      throw new UnauthorizedException({ ok: false, error: 'bridge_invalid' });
    }
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      throw new UnauthorizedException({ ok: false, error: 'bridge_invalid' });
    }
    let data: {
      typ?: string;
      id?: number;
      username?: string;
      role?: string;
      exp?: number;
    };
    try {
      data = JSON.parse(this.b64urlToBuf(payloadB64).toString('utf8'));
    } catch {
      throw new UnauthorizedException({ ok: false, error: 'bridge_invalid' });
    }
    if (data.typ !== 'farmsteam_bridge' || !Number.isFinite(Number(data.id))) {
      throw new UnauthorizedException({ ok: false, error: 'bridge_invalid' });
    }
    if (!Number.isFinite(Number(data.exp)) || Number(data.exp) < Date.now() / 1000) {
      throw new UnauthorizedException({ ok: false, error: 'bridge_expired' });
    }
    const user = await this.users.findById(Number(data.id));
    if (!user) {
      throw new UnauthorizedException({ ok: false, error: 'bridge_user' });
    }
    if (user.isDisabled) {
      throw new UnauthorizedException({ ok: false, error: 'Conta desativada' });
    }
    return this.issue(user);
  }
}
