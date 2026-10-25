import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtService } from '@nestjs/jwt';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { AuthThrottlerGuard } from './auth-throttler.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthPayload } from '../common/decorators/current-user.decorator';
import { UsersService } from '../users/users.service';

function safeBridgeNext(raw?: string) {
  const n = String(raw || '').trim();
  if (!n.startsWith('/') || n.startsWith('//')) return '/comunidade';
  return n;
}

class LoginDto {
  @IsString()
  username!: string;
  @IsString()
  password!: string;
  @IsOptional()
  desktop?: boolean | string;
}

class RegisterDto {
  @IsString()
  username!: string;
  @IsString()
  @MinLength(6)
  password!: string;
  @IsOptional()
  @IsString()
  display_name?: string;
  @IsString()
  captcha_token!: string;
  @IsString()
  captcha_answer!: string;
}

class SetupDto {
  @IsString()
  username!: string;
  @IsString()
  @MinLength(6)
  password!: string;
  @IsOptional()
  @IsString()
  display_name?: string;
}

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly jwt: JwtService,
  ) {}

  @Get('status')
  async status(
    @Req()
    req: {
      cookies?: Record<string, string | undefined>;
      headers: { authorization?: string; cookie?: string };
    },
  ) {
    let userId: number | undefined;
    try {
      const header = req.headers.authorization;
      const name = this.auth.cookieName();
      const token =
        req.cookies?.[name] ||
        req.cookies?.sf_react_token ||
        req.cookies?.sf_token ||
        (header?.startsWith('Bearer ') ? header.slice(7) : undefined);
      if (token) userId = (this.jwt.verify(token) as AuthPayload).id;
    } catch {
      /* not logged in */
    }
    return this.auth.status(userId);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: AuthPayload) {
    const row = await this.users.findById(user.id);
    return { ok: true, user: row ? this.users.toAuthUser(row) : null, desktop: false };
  }

  @Post('login')
  @UseGuards(AuthThrottlerGuard)
  async login(@Body() body: LoginDto, @Res({ passthrough: true }) res: Response) {
    const { token, payload } = await this.auth.login(body.username, body.password);
    res.cookie(this.auth.cookieName(), token, this.auth.cookieOptions());
    if (body.desktop) {
      res.cookie(this.auth.desktopCookieName(), '1', {
        ...this.auth.cookieOptions(),
        httpOnly: false,
      });
    }
    return payload;
  }

  @Get('captcha')
  captcha() {
    return this.auth.createCaptcha();
  }

  @Post('register')
  @UseGuards(AuthThrottlerGuard)
  async register(@Body() body: RegisterDto, @Res({ passthrough: true }) res: Response) {
    const { token, payload } = await this.auth.register(body);
    res.cookie(this.auth.cookieName(), token, this.auth.cookieOptions());
    return payload;
  }

  @Post('setup')
  @UseGuards(AuthThrottlerGuard)
  async setup(@Body() body: SetupDto, @Res({ passthrough: true }) res: Response) {
    const { token, payload } = await this.auth.setup(body);
    res.cookie(this.auth.cookieName(), token, this.auth.cookieOptions());
    return payload;
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(this.auth.cookieName(), { path: '/' });
    res.clearCookie(this.auth.desktopCookieName(), { path: '/' });
    res.clearCookie('sf_token', { path: '/' });
    res.clearCookie('sf_desktop', { path: '/' });
    return { ok: true };
  }

  /** Handoff farmsteam (Flask) → cookie JWT + redirect para a SPA. */
  @Get('bridge')
  async bridge(
    @Query('t') t: string | undefined,
    @Query('next') next: string | undefined,
    @Res() res: Response,
  ) {
    const dest = safeBridgeNext(next);
    try {
      const { token } = await this.auth.consumeBridgeToken(t);
      res.cookie(this.auth.cookieName(), token, this.auth.cookieOptions());
      return res.redirect(302, dest);
    } catch {
      return res.redirect(302, `/login?next=${encodeURIComponent(dest)}&bridge=1`);
    }
  }
}
