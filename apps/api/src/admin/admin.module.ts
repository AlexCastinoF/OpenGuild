import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminStorageService } from './admin-storage.service';
import { AdminUsersService } from './admin-users.service';
import { BrandService } from './brand.service';
import { BrandPublicController } from './brand-public.controller';
import { PabxModule } from '../pabx/pabx.module';
import { CommunityModule } from '../community/community.module';
import { UsersModule } from '../users/users.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PabxModule, CommunityModule, UsersModule, PrismaModule],
  controllers: [AdminController, BrandPublicController],
  providers: [AdminStorageService, AdminUsersService, BrandService],
  exports: [BrandService],
})
export class AdminModule {}
