import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { PrismaClient } from '../../generated/prisma/client.js';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(APP_ENV) env: Env) {
    this.client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: env.databaseUrl, max: env.databasePoolMax }),
    });
  }

  /** Lanza si la base no responde. */
  async ping(): Promise<void> {
    await this.client.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
