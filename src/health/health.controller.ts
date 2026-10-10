import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { DatabaseService } from '../shared/database/database.service.js';

/**
 * Endpoints operativos. Quedan fuera de /v1 y del contrato publico (openapi.yaml):
 * los consumen el orquestador y el monitoreo, no las apps.
 */
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
  async ready(): Promise<{ status: 'ok'; checks: { database: 'up' } }> {
    try {
      await this.database.ping();
    } catch {
      throw new HttpException(
        { status: 'unavailable', checks: { database: 'down' } },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { status: 'ok', checks: { database: 'up' } };
  }
}
