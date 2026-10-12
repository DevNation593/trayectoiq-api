import { Module } from '@nestjs/common';
import { UsageModule } from '../usage/usage.module.js';
import { VehiclesController } from './vehicles.controller.js';
import { VehiclesService } from './vehicles.service.js';

@Module({
  imports: [UsageModule],
  controllers: [VehiclesController],
  providers: [VehiclesService],
  exports: [VehiclesService],
})
export class VehiclesModule {}
