import { Module } from '@nestjs/common';
import { SteamService } from './steam.service';
import { TradesService } from './trades.service';
import { SteamController } from './steam.controller';

@Module({
  providers: [SteamService, TradesService],
  controllers: [SteamController],
  exports: [SteamService, TradesService],
})
export class SteamModule {}
