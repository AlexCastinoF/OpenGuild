import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthPayload } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { CommunityService } from './community.service';

class CreateServerDto {
  @IsString()
  name!: string;
}

class PatchServerDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() is_listed?: boolean;
  @IsOptional() @IsString() icon_url?: string;
  @IsOptional() @IsString() banner_url?: string;
}

class ChannelDto {
  @IsString() name!: string;
  @IsOptional() @IsString() kind?: string;
  @IsOptional() @IsString() icon_url?: string;
}

class MessageDto {
  @IsString() body!: string;
}

class JoinDto {
  @IsString() code!: string;
}

class ReorderDto {
  @IsArray() order!: number[];
}

class RoleDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsArray() permissions?: string[];
  @IsOptional() @IsBoolean() hoist?: boolean;
  @IsOptional() member_card_color?: string | null;
  @IsOptional() border_color?: string | null;
  @IsOptional() @IsString() border_effect?: string;
  @IsOptional() @IsString() border_motion?: string;
}

class MemberRolesDto {
  @IsArray() role_ids!: number[];
}

class UserRamalDto {
  @IsString()
  ramal!: string;
  @IsOptional() @IsNumber()
  server_id?: number;
}

class JoinRequestDto {
  @IsOptional() @IsString() message?: string;
}

class HandleJoinDto {
  @IsIn(['approve', 'deny'])
  action!: 'approve' | 'deny';
}

class DmDto {
  @IsString() body!: string;
  @IsOptional() @IsNumber() server_id?: number;
}

@Controller('api/community')
@UseGuards(JwtAuthGuard)
export class CommunityController {
  constructor(private readonly community: CommunityService) {}

  @Get('servers')
  listServers(@CurrentUser() user: AuthPayload) {
    return this.community.listServers(user.id);
  }

  @Post('servers')
  createServer(@CurrentUser() user: AuthPayload, @Body() body: CreateServerDto) {
    return this.community.createServer(user.id, body.name);
  }

  @Get('servers/:id')
  getServer(@CurrentUser() user: AuthPayload, @Param('id', ParseIntPipe) id: number) {
    return this.community.getServer(id, user.id);
  }

  @Patch('servers/:id')
  patchServer(
    @CurrentUser() user: AuthPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: PatchServerDto,
  ) {
    return this.community.patchServer(id, user.id, body);
  }

  @Delete('servers/:id')
  deleteServer(@CurrentUser() user: AuthPayload, @Param('id', ParseIntPipe) id: number) {
    return this.community.deleteServer(id, user.id);
  }

  @Post('servers/:id/channels')
  createChannel(
    @CurrentUser() user: AuthPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ChannelDto,
  ) {
    return this.community.createChannel(id, user.id, body);
  }

  @Post('servers/:id/channels/reorder')
  reorder(
    @CurrentUser() user: AuthPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ReorderDto,
  ) {
    return this.community.reorderChannels(id, user.id, body.order || []);
  }

  @Get('servers/:id/voice-presence')
  voicePresence(
    @CurrentUser() user: AuthPayload,
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
    @Query('ping_ms') ping_ms?: string,
    @Query('lat') lat?: string,
    @Query('lon') lon?: string,
    @Query('voice_channel_id') voice_channel_id?: string,
  ) {
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      ?.trim();
    const ip = forwarded || req.ip || '';
    return this.community.voicePresence(
      id,
      user.id,
      { ping_ms, lat, lon, voice_channel_id },
      ip,
    );
  }

  @Post('servers/:id/voice-leave')
  leaveVoice(
    @CurrentUser() user: AuthPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() body?: { offline?: boolean; channel_id?: number },
  ) {
    return this.community.leaveVoice(id, user.id, {
      offline: !!body?.offline,
      channelId: body?.channel_id != null ? Number(body.channel_id) : undefined,
    });
  }

  /** Fecha app/aba: remove da lista online imediatamente (além de sair da voz). */
  @Post('servers/:id/presence-offline')
  presenceOffline(
    @CurrentUser() user: AuthPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.community.leaveVoice(id, user.id, { offline: true });
  }

  @Post('servers/:id/invites')
  createInvite(@CurrentUser() user: AuthPayload, @Param('id', ParseIntPipe) id: number) {
    return this.community.createInvite(id, user.id);
  }

  @Get('servers/:id/roles')
  listRoles(@CurrentUser() user: AuthPayload, @Param('id', ParseIntPipe) id: number) {
    return this.community.listRoles(id, user.id);
  }

  @Post('servers/:id/roles')
  createRole(
    @CurrentUser() user: AuthPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: RoleDto,
  ) {
    return this.community.createRole(id, user.id, {
      name: body.name || 'Cargo',
      color: body.color,
      permissions: body.permissions,
    });
  }

  @Patch('servers/:id/roles/:roleId')
  patchRole(
    @CurrentUser() user: AuthPayload,
    @Param('id', ParseIntPipe) id: number,
    @Param('roleId', ParseIntPipe) roleId: number,
    @Body() body: RoleDto,
  ) {
    return this.community.patchRole(id, roleId, user.id, body);
  }

  @Delete('servers/:id/roles/:roleId')
  deleteRole(
    @CurrentUser() user: AuthPayload,
    @Param('id', ParseIntPipe) id: number,
    @Param('roleId', ParseIntPipe) roleId: number,
  ) {
    return this.community.deleteRole(id, roleId, user.id);
  }

  @Patch('servers/:id/members/:targetId/roles')
  setMemberRoles(
    @CurrentUser() user: AuthPayload,
    @Param('id', ParseIntPipe) id: number,
    @Param('targetId', ParseIntPipe) targetId: number,
    @Body() body: MemberRolesDto,
  ) {
    return this.community.setMemberRoles(id, user.id, targetId, body.role_ids || []);
  }

  @Post('servers/:id/members/:targetId/kick')
  kick(
    @CurrentUser() user: AuthPayload,
    @Param('id', ParseIntPipe) id: number,
    @Param('targetId', ParseIntPipe) targetId: number,
  ) {
    return this.community.kickMember(id, user.id, targetId);
  }

  @Post('servers/:id/members/:targetId/voice-disconnect')
  voiceDisconnect(
    @CurrentUser() user: AuthPayload,
    @Param('id', ParseIntPipe) id: number,
    @Param('targetId', ParseIntPipe) targetId: number,
    @Body() body: { channel_id?: number },
  ) {
    return this.community.disconnectVoiceMember(id, user.id, targetId, body?.channel_id);
  }

  @Post('users/:userId/profile')
  setUserRamal(
    @CurrentUser() user: AuthPayload,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() body: UserRamalDto,
  ) {
    return this.community.setUserRamal(user.id, userId, String(body.ramal ?? ''), body.server_id);
  }

  @Post('servers/:id/join-requests')
  createJoinRequest(
    @CurrentUser() user: AuthPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: JoinRequestDto,
  ) {
    return this.community.createJoinRequest(id, user.id, body.message || '');
  }

  @Get('channels/:id/messages')
  messages(
    @CurrentUser() user: AuthPayload,
    @Param('id', ParseIntPipe) id: number,
    @Query('after') after?: string,
  ) {
    return this.community.listMessages(id, user.id, after ? Number(after) : undefined);
  }

  @Post('channels/:id/messages')
  postMessage(
    @CurrentUser() user: AuthPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: MessageDto,
  ) {
    return this.community.postMessage(id, user.id, body.body);
  }

  @Delete('channels/:id/messages/:mid')
  deleteMessage(
    @CurrentUser() user: AuthPayload,
    @Param('id', ParseIntPipe) id: number,
    @Param('mid', ParseIntPipe) mid: number,
  ) {
    return this.community.deleteMessage(id, mid, user.id);
  }

  @Patch('channels/:id')
  patchChannel(
    @CurrentUser() user: AuthPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ChannelDto,
  ) {
    return this.community.patchChannel(id, user.id, {
      name: body.name,
      icon_url: body.icon_url,
    });
  }

  @Delete('channels/:id')
  deleteChannel(@CurrentUser() user: AuthPayload, @Param('id', ParseIntPipe) id: number) {
    return this.community.deleteChannel(id, user.id);
  }

  @Post('channels/:id/livekit-token')
  livekitToken(@CurrentUser() user: AuthPayload, @Param('id', ParseIntPipe) id: number) {
    return this.community.livekitToken(id, user.id);
  }

  @Post('join')
  join(@CurrentUser() user: AuthPayload, @Body() body: JoinDto) {
    return this.community.joinByCode(user.id, body.code);
  }

  @Public()
  @Get('invite/:code')
  invitePreview(@Param('code') code: string, @CurrentUser() user?: AuthPayload) {
    return this.community.invitePreview(code, user?.id);
  }

  @Get('discover')
  discover(@CurrentUser() user: AuthPayload) {
    return this.community.discover(user.id);
  }

  @Get('join-requests')
  listJoinRequests(@CurrentUser() user: AuthPayload) {
    return this.community.listJoinRequests(user.id, user.role === 'super_admin');
  }

  @Patch('join-requests/:id')
  handleJoin(
    @CurrentUser() user: AuthPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: HandleJoinDto,
  ) {
    return this.community.handleJoinRequest(
      id,
      user.id,
      body.action,
      user.role === 'super_admin',
    );
  }

  @Get('dm/unread')
  dmUnread(@CurrentUser() user: AuthPayload) {
    return this.community.dmUnread(user.id);
  }

  @Get('dm')
  dmThreads(@CurrentUser() user: AuthPayload) {
    return this.community.listDmThreads(user.id);
  }

  @Get('dm/:otherId')
  dmMessages(
    @CurrentUser() user: AuthPayload,
    @Param('otherId', ParseIntPipe) otherId: number,
    @Query('server_id') serverIdRaw?: string,
  ) {
    const serverId = serverIdRaw ? Number(serverIdRaw) : undefined;
    return this.community.listDmMessages(
      user.id,
      otherId,
      Number.isFinite(serverId) ? serverId : undefined,
    );
  }

  @Post('dm/:otherId')
  sendDm(
    @CurrentUser() user: AuthPayload,
    @Param('otherId', ParseIntPipe) otherId: number,
    @Body() body: DmDto,
  ) {
    return this.community.sendDm(user.id, otherId, body.body, body.server_id);
  }
}
