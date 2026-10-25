import { Module } from '@nestjs/common';
import { PresenceService } from './presence.service';
import { GeoService } from './geo.service';

@Module({
  providers: [PresenceService, GeoService],
  exports: [PresenceService, GeoService],
})
export class PresenceModule {}
