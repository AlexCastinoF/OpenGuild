import { Module } from '@nestjs/common';
import { Cs2Controller } from './cs2.controller';
import { Cs2Service } from './cs2.service';

@Module({
  controllers: [Cs2Controller],
  providers: [Cs2Service],
  exports: [Cs2Service],
})
export class Cs2Module {}
