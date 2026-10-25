import { Module } from '@nestjs/common';
import { PabxService } from './pabx.service';

@Module({
  providers: [PabxService],
  exports: [PabxService],
})
export class PabxModule {}
