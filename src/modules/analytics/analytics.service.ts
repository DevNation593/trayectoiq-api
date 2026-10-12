import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../shared/clock/clock.js';
import { DatabaseService } from '../../shared/database/database.service.js';
import {
  type ClientEvent,
  type EventProperties,
  isEssential,
  sanitizeClientEvent,
  type ServerEventName,
} from './event-catalog.js';

export interface ServerEvent {
  name: ServerEventName;
  userId: string;
  properties: EventProperties;
  /** Cuando ocurrio el hecho. Por defecto, ahora. */
  occurredAt?: Date;
}

export interface ClientBatch {
  /** Usuario de la sesion, si la app envio un bearer valido. */
  userId: string | null;
  anonymousId: string;
  events: ClientEvent[];
}

/**
 * Eventos de producto en analytics_events (08_ANALYTICS_VALIDATION.md). Ningun metodo lanza:
 * si escribir un evento falla, la operacion de negocio que lo origino termina igual.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger('Analytics');

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Registra un hecho ocurrido en el servidor. */
  async record(event: ServerEvent): Promise<void> {
    try {
      const now = this.clock.now();
      const properties = JSON.stringify(event.properties);
      // Una sola sentencia: el evento de producto de un usuario que desactivo analytics no se inserta.
      await this.database.client.$executeRaw`
        INSERT INTO analytics_events (user_id, event_name, properties, occurred_at, received_at)
        SELECT ${event.userId}::uuid, ${event.name}, ${properties}::jsonb, ${event.occurredAt ?? now}, ${now}
        WHERE ${isEssential(event.name)}::boolean OR NOT EXISTS (
          SELECT 1 FROM users WHERE id = ${event.userId}::uuid AND analytics_opt_out
        )`;
    } catch (error) {
      this.warn(event.name, error);
    }
  }

  /** Guarda los eventos permitidos de un lote enviado por la app. */
  async ingest(batch: ClientBatch): Promise<void> {
    try {
      const now = this.clock.now();
      const accepted = batch.events.flatMap((event) => sanitizeClientEvent(event, now) ?? []);
      if (accepted.length === 0 || (batch.userId && (await this.optedOut(batch.userId)))) {
        return;
      }
      await this.database.client.analyticsEvent.createMany({
        data: accepted.map((event) => ({
          userId: batch.userId,
          anonymousId: batch.anonymousId,
          eventName: event.name,
          eventVersion: event.version,
          properties: event.properties,
          occurredAt: event.occurredAt,
          receivedAt: now,
        })),
      });
    } catch (error) {
      this.warn('lote de la app', error);
    }
  }

  private async optedOut(userId: string): Promise<boolean> {
    const user = await this.database.client.user.findUnique({
      where: { id: userId },
      select: { analyticsOptOut: true },
    });
    return user?.analyticsOptOut === true;
  }

  /** Solo el nombre del evento y el tipo de error: las propiedades no van al log. */
  private warn(what: string, error: unknown): void {
    this.logger.warn(
      `No se pudo guardar el evento (${what}): ${error instanceof Error ? error.name : 'error'}`,
    );
  }
}
