import { Global, Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service.js';
import { EventsController } from './events.controller.js';

/** Infraestructura de eventos de producto; cualquier modulo salvo pricing puede usarla. */
@Global()
@Module({
  controllers: [EventsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
