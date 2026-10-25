import { Module } from '@nestjs/common';
import { YoutubeController } from './youtube.controller';

@Module({
  controllers: [YoutubeController],
})
export class YoutubeModule {}
