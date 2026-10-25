import { Module, forwardRef } from '@nestjs/common';
import { CommunityService } from './community.service';
import { CommunityController } from './community.controller';
import { UsersModule } from '../users/users.module';
import { PresenceModule } from '../presence/presence.module';
import { VoiceModule } from '../voice/voice.module';
import { PabxModule } from '../pabx/pabx.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [
    UsersModule,
    PresenceModule,
    VoiceModule,
    PabxModule,
    forwardRef(() => RealtimeModule),
  ],
  providers: [CommunityService],
  controllers: [CommunityController],
  exports: [CommunityService],
})
export class CommunityModule {}
