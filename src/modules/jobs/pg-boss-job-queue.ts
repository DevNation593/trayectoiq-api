import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import {
  DEFAULT_RETRY_DELAY_SECONDS,
  DEFAULT_RETRY_LIMIT,
  type JobHandler,
  type JobOptions,
  type JobQueue,
} from './job-queue.js';

interface Registration {
  handler: JobHandler<object>;
  options: JobOptions;
}

/** Los trabajos terminados se borran pronto: su contenido puede llevar un codigo o un token. */
const DELETE_FINISHED_AFTER_SECONDS = 60 * 60;

/**
 * Cola sobre PostgreSQL con pg-boss (ADR-003): sin Redis, usa su propio esquema `pgboss` en la
 * misma base. Los workers corren en el proceso de la API durante el MVP.
 */
@Injectable()
export class PgBossJobQueue implements JobQueue, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Jobs');
  private readonly boss: PgBoss;
  private readonly registrations = new Map<string, Registration>();
  private started: Promise<void> | null = null;

  constructor(@Inject(APP_ENV) env: Env) {
    this.boss = new PgBoss({ connectionString: env.databaseUrl });
    this.boss.on('error', (error) => this.logger.error(error));
  }

  register<T extends object>(name: string, handler: JobHandler<T>, options: JobOptions = {}): void {
    if (this.started) {
      throw new Error(`El trabajo "${name}" se registro despues de arrancar la cola`);
    }
    this.registrations.set(name, { handler: handler as JobHandler<object>, options });
  }

  async enqueue<T extends object>(name: string, payload: T): Promise<void> {
    await this.start();
    await this.boss.send(name, payload);
  }

  onApplicationBootstrap(): Promise<void> {
    return this.start();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.started) {
      await this.started.catch(() => undefined);
      await this.boss.stop({ graceful: true, timeout: 5_000 });
    }
  }

  private start(): Promise<void> {
    this.started ??= this.boot();
    return this.started;
  }

  private async boot(): Promise<void> {
    await this.boss.start();
    for (const [name, { handler, options }] of this.registrations) {
      await this.boss.createQueue(name, {
        retryLimit: options.retryLimit ?? DEFAULT_RETRY_LIMIT,
        retryDelay: options.retryDelaySeconds ?? DEFAULT_RETRY_DELAY_SECONDS,
        retryBackoff: true,
        deleteAfterSeconds: DELETE_FINISHED_AFTER_SECONDS,
      });
      await this.boss.work<object>(name, { pollingIntervalSeconds: 0.5 }, async (jobs) => {
        for (const job of jobs) {
          await handler(job.data);
        }
      });
    }
  }
}
