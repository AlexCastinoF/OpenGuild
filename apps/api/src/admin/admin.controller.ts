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
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../common/guards/super-admin.guard';
import { CurrentUser, AuthPayload } from '../common/decorators/current-user.decorator';
import { PabxService } from '../pabx/pabx.service';
import { CommunityService } from '../community/community.service';
import { AdminStorageService } from './admin-storage.service';
import { AdminUsersService } from './admin-users.service';
import { BrandService } from './brand.service';

class PabxDto {
  @IsOptional() @IsString() api_base?: string;
  @IsOptional() @IsString() usuario?: string;
  @IsOptional() @IsString() token?: string;
}

class AdminServerPatchDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() is_listed?: boolean;
  @IsOptional() @IsBoolean() is_blocked?: boolean;
}

class AdminUserPatchDto {
  @IsOptional() @IsString() role?: string;
  @IsOptional() @IsBoolean() premium_themes?: boolean;
  @IsOptional() @IsBoolean() is_disabled?: boolean;
  @IsOptional() @IsString() work_status?: string;
  @IsOptional() @IsString() display_name?: string;
  @IsOptional() @IsString() password?: string;
}

class BrandDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() short_name?: string;
  @IsOptional() @IsString() logo_url?: string;
  @IsOptional() @IsString() favicon_url?: string;
  @IsOptional() @IsString() app_icon_url?: string;
  @IsOptional() @IsString() app_ico_url?: string;
}

class KickDto {
  @IsInt()
  server_id!: number;
}

class CleanupDto {
  @IsOptional() @IsString() root_id?: string;
  @IsOptional() @IsInt() keep?: number;
}

@Controller('api/community/admin')
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class AdminController {
  constructor(
    private readonly pabx: PabxService,
    private readonly community: CommunityService,
    private readonly storage: AdminStorageService,
    private readonly adminUsers: AdminUsersService,
    private readonly brand: BrandService,
  ) {}

  @Get('brand')
  getBrand() {
    return this.brand.publicBrand();
  }

  @Post('brand')
  saveBrand(@Body() body: BrandDto) {
    return this.brand.save(body);
  }

  @Get('pabx')
  getPabx() {
    return this.pabx.publicSettings();
  }

  @Post('pabx')
  async savePabx(@Body() body: PabxDto) {
    await this.pabx.saveConfig(body);
    return this.pabx.publicSettings();
  }

  @Get('servers')
  servers() {
    return this.community.adminServers();
  }

  @Patch('servers/:id')
  patchServer(@Param('id', ParseIntPipe) id: number, @Body() body: AdminServerPatchDto) {
    return this.community.adminPatchServer(id, body);
  }

  @Delete('servers/:id')
  deleteServer(@Param('id', ParseIntPipe) id: number) {
    return this.community.adminDeleteServer(id);
  }

  @Get('channels')
  channels() {
    return this.community.adminChannels();
  }

  @Delete('channels/:id')
  async deleteChannel(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthPayload) {
    // Superadmin: delete via owner path bypass — use prisma through community helper
    return this.community.adminDeleteChannel(id, user.id);
  }

  @Get('storage')
  storageList(@Query('root') root?: string) {
    return this.storage.list(root || undefined);
  }

  @Delete('storage/:rootId/:name')
  storageDelete(
    @Param('rootId') rootId: string,
    @Param('name') name: string,
  ) {
    return this.storage.deleteFile(rootId, decodeURIComponent(name));
  }

  @Post('storage/cleanup')
  storageCleanup(@Body() body: CleanupDto) {
    const root = body.root_id || 'desktop-releases';
    return this.storage.cleanupDesktop(root, body.keep ?? 1);
  }

  @Get('users')
  users(@Query('q') q?: string) {
    return this.adminUsers.list(q);
  }

  @Patch('users/:id')
  patchUser(@Param('id', ParseIntPipe) id: number, @Body() body: AdminUserPatchDto) {
    return this.adminUsers.patch(id, body);
  }

  @Delete('users/:id')
  deleteUser(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthPayload) {
    return this.adminUsers.remove(id, user.id);
  }

  @Post('users/:id/kick')
  kickUser(@Param('id', ParseIntPipe) id: number, @Body() body: KickDto) {
    return this.adminUsers.kickFromServer(id, body.server_id);
  }

  @Delete('users/:id/theme')
  clearTheme(@Param('id', ParseIntPipe) id: number) {
    return this.adminUsers.clearTheme(id);
  }
}
