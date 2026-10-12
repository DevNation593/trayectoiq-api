import { Module } from '@nestjs/common';
import { RoutingModule } from '../routing/routing.module.js';
import { UsageModule } from '../usage/usage.module.js';
import { VehiclesModule } from '../vehicles/vehicles.module.js';
import { QuotesController } from './quotes.controller.js';
import { QuotesService } from './quotes.service.js';

@Module({
  imports: [VehiclesModule, RoutingModule, UsageModule],
  controllers: [QuotesController],
  providers: [QuotesService],
})
export class QuotesModule {}
