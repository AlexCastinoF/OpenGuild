import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { PresenceModule } from '../presence/presence.module';
import { CommunityModule } from '../community/community.module';
import { PrivateMatchController } from './private-match.controller';
import { PrivateMatchService } from './private-match.service';
import { Cs2TunnelService } from './cs2-tunnel.service';

@Module({
  imports: [PrismaModule, RealtimeModule, PresenceModule, CommunityModule],
  controllers: [PrivateMatchController],
  providers: [PrivateMatchService, Cs2TunnelService],
  exports: [PrivateMatchService],
})
export class PrivateMatchModule {}
