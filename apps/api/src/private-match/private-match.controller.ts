import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthPayload } from '../common/decorators/current-user.decorator';
import { MatchMode, PrivateMatchService } from './private-match.service';

class CreateDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  server_id!: number;

  @IsIn(['valve', 'host_listen'])
  mode!: MatchMode;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  room_password?: string;

  @IsOptional()
  @IsString()
  format?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  mr?: number;

  @IsOptional()
  @IsBoolean()
  overtime?: boolean;

  @IsOptional()
  invite_ids?: number[];

  @IsOptional()
  @IsObject()
  admin_settings?: Record<string, number>;

  /** Versão do pack remoto SfAssignTeams escolhida pelo host. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  match_pack_version?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  welcome_message?: string;

  /** Cor da mensagem no chat CS2: green|lime|yellow|lightblue|white|olive */
  @IsOptional()
  @IsString()
  @MaxLength(24)
  welcome_color?: string;
}

class InviteDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  target_id!: number;
}

class RespondDto {
  @IsBoolean()
  accept!: boolean;
}

class ReadyDto {
  @IsBoolean()
  ready!: boolean;
}

class TeamDto {
  @IsIn(['CT', 'T'])
  team!: 'CT' | 'T';
}

class HostTeamDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  target_id!: number;

  @IsIn(['CT', 'T', 'SPEC'])
  team!: 'CT' | 'T' | 'SPEC';
}

class VoteDto {
  @IsString()
  map_id!: string;
}

class HostReadyDto {
  @IsOptional()
  @IsString()
  host?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  port?: number;

  @IsOptional()
  @IsString()
  password?: string;
}

class ConnectedDto {
  @IsBoolean()
  connected!: boolean;
}

class PresenceDto {
  @IsOptional()
  players?: Array<{
    steamid?: string;
    name?: string;
    userId?: number;
    inServer?: boolean;
    alive?: boolean | null;
    health?: number | null;
    gameTeam?: 'CT' | 'T' | 'SPEC' | '';
  }>;
}

class StatsDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  score_ct?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  score_t?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  round?: number;

  @IsOptional()
  @IsString()
  phase?: string;

  @IsOptional()
  stats?: Array<Record<string, unknown>>;

  @IsOptional()
  @IsBoolean()
  merge?: boolean;

  @IsOptional()
  feed_item?: { t?: string; type?: string; text?: string };
}

class BootProgressDto {
  @IsString()
  @MaxLength(64)
  phase!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  message?: string;
}

@Controller('api/private-match')
@UseGuards(JwtAuthGuard)
export class PrivateMatchController {
  constructor(private readonly matches: PrivateMatchService) {}

  @Get()
  list(@CurrentUser() user: AuthPayload) {
    return this.matches.listForUser(user.id);
  }

  @Get('server/:serverId')
  listServer(@CurrentUser() user: AuthPayload, @Param('serverId') serverId: string) {
    return this.matches.listForServer(Number(serverId), user.id);
  }

  @Get('server/:serverId/ranking')
  ranking(@Param('serverId') serverId: string) {
    return this.matches.ranking(Number(serverId));
  }

  @Get('server/:serverId/history')
  history(@Param('serverId') serverId: string) {
    return this.matches.history(Number(serverId));
  }

  @Get(':id')
  one(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.matches.getMatch(user.id, id);
  }

  @Post()
  create(@CurrentUser() user: AuthPayload, @Body() body: CreateDto) {
    const inviteIds = Array.isArray(body.invite_ids)
      ? body.invite_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    return this.matches.create({
      hostUserId: user.id,
      serverId: body.server_id,
      mode: body.mode,
      name: body.name,
      roomPassword: body.room_password,
      format: body.format,
      mr: body.mr,
      overtime: body.overtime,
      inviteUserIds: inviteIds,
      adminSettings: body.admin_settings,
      matchPackVersion: body.match_pack_version,
      welcomeMessage: body.welcome_message,
      welcomeColor: body.welcome_color,
    });
  }

  @Post(':id/join')
  join(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.matches.joinLobby(user.id, id);
  }

  @Post(':id/spectate')
  spectate(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.matches.spectate(user.id, id);
  }

  @Post(':id/invite')
  invite(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Body() body: InviteDto,
  ) {
    return this.matches.invite(user.id, id, body.target_id);
  }

  @Post(':id/respond')
  respond(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Body() body: RespondDto,
  ) {
    return this.matches.respondInvite(user.id, id, body.accept);
  }

  @Post(':id/ready')
  ready(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Body() body: ReadyDto,
  ) {
    return this.matches.setReady(user.id, id, body.ready);
  }

  @Post(':id/team')
  team(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Body() body: TeamDto,
  ) {
    return this.matches.setTeam(user.id, id, body.team);
  }

  @Post(':id/host-team')
  hostTeam(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Body() body: HostTeamDto,
  ) {
    return this.matches.hostSetTeam(user.id, id, body.target_id, body.team);
  }

  @Post(':id/admin-settings')
  adminSettings(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(body || {})) {
      if (k === 'restart' || k.startsWith('welcome_')) continue;
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n)) clean[k] = n;
    }
    return this.matches.setAdminSettings(user.id, id, clean);
  }

  @Post(':id/vote/start')
  voteStart(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.matches.startVote(user.id, id);
  }

  @Post(':id/vote')
  vote(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Body() body: VoteDto,
  ) {
    return this.matches.castVote(user.id, id, body.map_id);
  }

  @Post(':id/veto/ban')
  vetoBan(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Body() body: VoteDto,
  ) {
    return this.matches.vetoBan(user.id, id, body.map_id);
  }

  @Post(':id/veto/side')
  vetoSide(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Body() body: TeamDto,
  ) {
    return this.matches.vetoSide(user.id, id, body.team);
  }

  @Post(':id/vote/end')
  voteEnd(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.matches.endVote(user.id, id);
  }

  @Post(':id/tunnel')
  openTunnel(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.matches.openTunnel(user.id, id);
  }

  @Post(':id/host-ready')
  hostReady(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Body() body: HostReadyDto,
  ) {
    return this.matches.hostReady(user.id, id, {
      host: body.host,
      port: body.port,
      password: body.password,
    });
  }

  @Post(':id/boot-progress')
  bootProgress(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Body() body: BootProgressDto,
  ) {
    return this.matches.setBootProgress(user.id, id, body.phase, body.message);
  }

  @Post(':id/valve-start')
  valveStart(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.matches.startValve(user.id, id);
  }

  @Post(':id/connected')
  connected(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Body() body: ConnectedDto,
  ) {
    return this.matches.markConnected(user.id, id, body.connected);
  }

  @Post(':id/presence')
  presence(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Body() body: PresenceDto,
  ) {
    return this.matches.syncPresence(user.id, id, body.players || []);
  }

  @Post(':id/stats')
  stats(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Body() body: StatsDto,
  ) {
    return this.matches.ingestStats(user.id, id, {
      scoreCt: body.score_ct,
      scoreT: body.score_t,
      round: body.round,
      phase: body.phase,
      merge: body.merge !== false,
      stats: body.stats as never,
      feedItem: body.feed_item?.text
        ? {
            t: body.feed_item.t || '',
            type: body.feed_item.type || 'kill',
            text: body.feed_item.text,
          }
        : undefined,
    });
  }

  @Post(':id/end')
  end(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.matches.end(user.id, id);
  }
}
