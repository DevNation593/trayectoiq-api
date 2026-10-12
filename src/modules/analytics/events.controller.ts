import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { OptionalAuth } from '../../shared/auth/public.decorator.js';
import { Operation } from '../../shared/contract/contract.guard.js';
import { RateLimit } from '../../shared/rate-limit/rate-limit.guard.js';
import { AnalyticsService } from './analytics.service.js';
import type { ClientEvent } from './event-catalog.js';

/** Esquema EventBatch de openapi.yaml. */
interface EventBatch {
  anonymousId: string;
  events: ClientEvent[];
}

/** Eventos de producto que solo la app puede ver (08_ANALYTICS_VALIDATION.md seccion 2). */
@Controller('events')
export class EventsController {
  constructor(@Inject(AnalyticsService) private readonly analytics: AnalyticsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @OptionalAuth()
  @Operation('ingestEvents')
  @RateLimit('events')
  async ingest(@Req() request: FastifyRequest, @Body() batch: EventBatch): Promise<void> {
    await this.analytics.ingest({
      userId: request.auth?.userId ?? null,
      anonymousId: batch.anonymousId,
      events: batch.events,
    });
  }
}
