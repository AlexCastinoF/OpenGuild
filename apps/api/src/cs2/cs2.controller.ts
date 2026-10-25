import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser, AuthPayload } from '../common/decorators/current-user.decorator';
import { Cs2Service } from './cs2.service';

class SaveAuthDto {
  @IsString()
  auth_code!: string;

  @IsString()
  known_code!: string;
}

class AutoEnrichDto {
  @IsOptional()
  @IsBoolean()
  force?: boolean;

  @IsOptional()
  gsi_match?: Record<string, unknown>;
}

class AutoToggleDto {
  @IsBoolean()
  enabled!: boolean;
}

@Controller('api/cs2')
@UseGuards(JwtAuthGuard)
export class Cs2Controller {
  constructor(private readonly cs2: Cs2Service) {}

  @Get('matches/status')
  status(@CurrentUser() user: AuthPayload) {
    return this.cs2.authStatus(user.id);
  }

  @Get('matches')
  async list(@CurrentUser() user: AuthPayload) {
    const matches = await this.cs2.listMatches(user.id);
    return { ok: true, matches, status: await this.cs2.authStatus(user.id) };
  }

  @Post('matches/auth')
  saveAuth(@CurrentUser() user: AuthPayload, @Body() body: SaveAuthDto) {
    return this.cs2.saveAuth(user.id, body.auth_code, body.known_code);
  }

  @Delete('matches/auth')
  clearAuth(@CurrentUser() user: AuthPayload) {
    return this.cs2.clearAuth(user.id);
  }

  @Post('matches/auto-enrich/toggle')
  toggle(@CurrentUser() user: AuthPayload, @Body() body: AutoToggleDto) {
    return this.cs2.setAutoEnrich(user.id, body.enabled);
  }

  @Post('matches/sync')
  sync(@CurrentUser() user: AuthPayload) {
    return this.cs2.syncCodes(user.id);
  }

  @Post('matches/auto-enrich')
  autoEnrich(@CurrentUser() user: AuthPayload, @Body() body: AutoEnrichDto) {
    return this.cs2.autoEnrich(user.id, {
      force: body.force,
      gsi_match: body.gsi_match,
    });
  }
}
