import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../shared/auth/public.decorator.js';
import { DatabaseService } from '../shared/database/database.service.js';

interface Readiness {
  status: 'ok' | 'unavailable';
  checks: { database: 'up' | 'down' };
}

/**
 * Endpoints operativos. Quedan fuera de /v1 y del contrato publico (openapi.yaml):
 * los consumen el orquestador y el monitoreo, no las apps. Por eso su cuerpo no es ProblemDetails.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** Liveness: el proceso atiende peticiones. No toca dependencias. */
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: la API puede servir trafico, es decir, llega a la base. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<Readiness> {
    try {
      await this.database.ping();
    } catch {
      void reply.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'unavailable', checks: { database: 'down' } };
    }
    return { status: 'ok', checks: { database: 'up' } };
  }
}
