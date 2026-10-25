import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Allow, IsObject, IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthPayload } from '../common/decorators/current-user.decorator';
import { UsersService } from './users.service';
import { PresenceService } from '../presence/presence.service';

class WorkStatusDto {
  /** Permite "" (Disponível); @IsOptional sozinho ignora string vazia no whitelist. */
  @Allow()
  @IsOptional()
  @IsString()
  status?: string;

  @Allow()
  @IsOptional()
  @IsString()
  work_status?: string;
}

class ProfileDto {
  @Allow()
  @IsOptional()
  @IsString()
  display_name?: string;

  @Allow()
  @IsOptional()
  @IsString()
  ramal?: string;

  @Allow()
  @IsOptional()
  @IsString()
  avatar_url?: string;

  @Allow()
  @IsOptional()
  @IsString()
  password?: string;
}

class ActivityDto {
  @Allow()
  @IsOptional()
  @IsObject()
  activity?: {
    type: string;
    title?: string;
    url?: string;
    videoId?: string;
    startedAt?: number;
  } | null;
}

class Cs2LiveDto {
  @Allow()
  @IsOptional()
  @IsObject()
  cs2_live?: {
    at?: number;
    map?: string;
    scoreCt?: number;
    scoreT?: number;
    team?: string;
    kills?: number;
    deaths?: number;
    health?: number;
    kind?: string;
    mode?: string;
    modeLabel?: string;
    phase?: string;
  } | null;
}

@Controller('api/community/me')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly presence: PresenceService,
  ) {}

  @Post('work-status')
  workStatus(@CurrentUser() user: AuthPayload, @Body() body: WorkStatusDto) {
    const raw =
      body.status !== undefined
        ? body.status
        : body.work_status !== undefined
          ? body.work_status
          : '';
    return this.users.setWorkStatus(user.id, raw);
  }

  @Get('profile')
  profile(@CurrentUser() user: AuthPayload) {
    return this.users.getProfile(user.id);
  }

  @Post('profile')
  updateProfile(@CurrentUser() user: AuthPayload, @Body() body: ProfileDto) {
    return this.users.updateProfile(user.id, body);
  }

  @Post('activity')
  async activity(@CurrentUser() user: AuthPayload, @Body() body: ActivityDto) {
    const act = body.activity === undefined ? null : body.activity;
    await this.presence.setGlobalActivity(user.id, act);
    return { ok: true as const, activity: act };
  }

  @Post('cs2-live')
  async cs2Live(@CurrentUser() user: AuthPayload, @Body() body: Cs2LiveDto) {
    const raw = body.cs2_live === undefined ? null : body.cs2_live;
    if (!raw) {
      await this.presence.setCs2Live(user.id, null);
      return { ok: true as const, cs2_live: null };
    }
    const kind = (raw.kind === 'lobby' ? 'lobby' : 'match') as 'match' | 'lobby';
    const live: import('../presence/presence.service').Cs2LiveShare = {
      at: Number(raw.at) || Date.now(),
      map: String(raw.map || 'CS2').slice(0, 64),
      scoreCt: Math.max(0, Math.min(99, Number(raw.scoreCt) || 0)),
      scoreT: Math.max(0, Math.min(99, Number(raw.scoreT) || 0)),
      team:
        String(raw.team || '').toUpperCase() === 'T'
          ? 'T'
          : String(raw.team || '').toUpperCase() === 'CT'
            ? 'CT'
            : '',
      kills: Math.max(0, Math.min(999, Number(raw.kills) || 0)),
      deaths: Math.max(0, Math.min(999, Number(raw.deaths) || 0)),
      health: Math.max(0, Math.min(100, Number(raw.health) || 0)),
      kind,
      mode: String(raw.mode || '').slice(0, 64),
      modeLabel: String(raw.modeLabel || '').slice(0, 64),
      phase: String(raw.phase || '').slice(0, 32),
    };
    await this.presence.setCs2Live(user.id, live);
    return { ok: true as const, cs2_live: live };
  }
}
