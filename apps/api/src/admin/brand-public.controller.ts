import { Controller, Get } from '@nestjs/common';
import { BrandService } from '../admin/brand.service';

/** Público — web + Electron leem a marca sem login. */
@Controller('api/community')
export class BrandPublicController {
  constructor(private readonly brand: BrandService) {}

  @Get('brand')
  get() {
    return this.brand.publicBrand();
  }
}
