import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthPayload } from '../common/decorators/current-user.decorator';
import { RemoteDirection, RemoteService } from './remote.service';

class RequestDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  server_id!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  target_id!: number;

  @IsIn(['control_target', 'invite_helper'])
  direction!: RemoteDirection;
}

class RespondDto {
  @IsBoolean()
  accept!: boolean;
}

class RegisterAgentDto {
  @IsString()
  rustdesk_id!: string;
}

class HostReadyDto {
  @IsString()
  rustdesk_id!: string;

  @IsOptional()
  @IsString()
  session_password?: string;
}

@Controller('api/remote')
@UseGuards(JwtAuthGuard)
export class RemoteController {
  constructor(private readonly remote: RemoteService) {}

  @Get('config')
  config() {
    return this.remote.getConfig();
  }

  @Get('active')
  active(@CurrentUser() user: AuthPayload) {
    return this.remote.getActiveForUser(user.id);
  }

  @Get('agents')
  agents(
    @CurrentUser() user: AuthPayload,
    @Query('ids') ids?: string,
  ) {
    const list = String(ids || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    return this.remote.agentStatus(user.id, list);
  }

  @Post('agent/register')
  register(@CurrentUser() user: AuthPayload, @Body() body: RegisterAgentDto) {
    return this.remote.registerAgent(user.id, body.rustdesk_id);
  }

  @Post('agent/heartbeat')
  heartbeat(@CurrentUser() user: AuthPayload) {
    return this.remote.agentHeartbeat(user.id);
  }

  @Post('request')
  request(@CurrentUser() user: AuthPayload, @Body() body: RequestDto) {
    return this.remote.request({
      requesterId: user.id,
      serverId: body.server_id,
      targetId: body.target_id,
      direction: body.direction,
    });
  }

  @Post(':id/respond')
  respond(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Body() body: RespondDto,
  ) {
    return this.remote.respond({
      sessionId: id,
      userId: user.id,
      accept: !!body.accept,
    });
  }

  @Post(':id/host-ready')
  hostReady(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Body() body: HostReadyDto,
  ) {
    return this.remote.hostReady({
      sessionId: id,
      userId: user.id,
      rustdeskId: body.rustdesk_id,
      sessionPassword: body.session_password,
    });
  }

  @Post(':id/end')
  end(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.remote.end({ sessionId: id, userId: user.id });
  }
}
