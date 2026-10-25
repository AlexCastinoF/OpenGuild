import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser, AuthPayload } from '../common/decorators/current-user.decorator';
import { LiveService } from './live.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

class LiveStartDto {
  @Type(() => Number)
  @IsInt()
  server_id!: number;

  @Type(() => Number)
  @IsInt()
  channel_id!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsBoolean()
  public_watch?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  public_watch_max?: number;

  @IsOptional()
  @IsBoolean()
  public_watch_custom_names?: boolean;

  @IsOptional()
  @IsBoolean()
  public_watch_chat_enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  public_watch_chat_guest_post?: boolean;
}

class LiveStopDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  session_id?: number;
}

class GuestNameDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  name?: string;
}

function requestOrigin(req: Request): string {
  const env = (process.env.PUBLIC_ORIGIN || process.env.APP_ORIGIN || '').trim();
  if (env) return env.replace(/\/$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    ?.trim();
  return host ? `${proto}://${host}` : '';
}

@Controller()
export class LiveController {
  constructor(private readonly live: LiveService) {}

  @Post('api/community/live/start')
  @UseGuards(JwtAuthGuard)
  start(
    @CurrentUser() user: AuthPayload,
    @Body() body: LiveStartDto,
    @Req() req: Request,
  ) {
    return this.live.start({
      userId: user.id,
      serverId: body.server_id,
      channelId: body.channel_id,
      title: body.title,
      publicWatch: body.public_watch !== false,
      publicWatchMax: body.public_watch_max,
      publicWatchCustomNames: body.public_watch_custom_names,
      publicWatchChat: body.public_watch_chat_enabled,
      publicWatchChatPost: body.public_watch_chat_guest_post,
      origin: requestOrigin(req),
    });
  }

  @Post('api/community/live/stop')
  @UseGuards(JwtAuthGuard)
  stop(@CurrentUser() user: AuthPayload, @Body() body: LiveStopDto) {
    return this.live.stop(user.id, body.session_id);
  }

  @Get('api/community/live/active')
  @UseGuards(JwtAuthGuard)
  active(@CurrentUser() user: AuthPayload, @Req() req: Request) {
    return this.live.activeForUser(user.id, requestOrigin(req));
  }

  @Get('api/public/watch/:slug')
  publicInfo(@Param('slug') slug: string, @Req() req: Request) {
    return this.live.publicInfo(slug, requestOrigin(req));
  }

  @Post('api/public/watch/:slug/token')
  guestToken(@Param('slug') slug: string, @Body() body: GuestNameDto) {
    return this.live.guestToken(slug, body.name || '');
  }
}
