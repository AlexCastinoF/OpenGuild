import { Module } from '@nestjs/common';
import { WaController } from './wa.controller';
import { WaService } from './wa.service';
import { ZapoClient } from './zapo.client';

@Module({
  providers: [ZapoClient, WaService],
  controllers: [WaController],
  exports: [WaService, ZapoClient],
})
export class WaModule {}
