import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { join } from 'path';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { CommunityModule } from './community/community.module';
import { PresenceModule } from './presence/presence.module';
import { VoiceModule } from './voice/voice.module';
import { PabxModule } from './pabx/pabx.module';
import { AdminModule } from './admin/admin.module';
import { RealtimeModule } from './realtime/realtime.module';
import { MediaModule } from './media/media.module';
import { DesktopController } from './desktop/desktop.controller';
import { MatchPacksController } from './match-packs/match-packs.controller';
import { LiveModule } from './live/live.module';
import { SteamModule } from './steam/steam.module';
import { StreamModule } from './stream/stream.module';
import { WaModule } from './wa/wa.module';
import { ThemesModule } from './themes/themes.module';
import { YoutubeModule } from './youtube/youtube.module';
import { RemoteModule } from './remote/remote.module';
import { Cs2Module } from './cs2/cs2.module';
import { PrivateMatchModule } from './private-match/private-match.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        join(__dirname, '..', '..', '..', '.env'),
        join(process.cwd(), '.env'),
        join(process.cwd(), '..', '..', '.env'),
      ],
    }),
    PrismaModule,
    RedisModule,
    AuthModule,
    UsersModule,
    CommunityModule,
    PresenceModule,
    VoiceModule,
    PabxModule,
    AdminModule,
    RealtimeModule,
    MediaModule,
    LiveModule,
    SteamModule,
    StreamModule,
    WaModule,
    ThemesModule,
    YoutubeModule,
    RemoteModule,
    Cs2Module,
    PrivateMatchModule,
  ],
  controllers: [DesktopController, MatchPacksController],
})
export class AppModule {}
