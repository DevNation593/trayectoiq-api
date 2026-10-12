import { Global, Module } from '@nestjs/common';
import { JOB_QUEUE } from './job-queue.js';
import { Mailer } from './mailer.js';
import { PgBossJobQueue } from './pg-boss-job-queue.js';

/** Infraestructura de trabajos en segundo plano; cualquier modulo salvo pricing puede usarla. */
@Global()
@Module({
  providers: [{ provide: JOB_QUEUE, useClass: PgBossJobQueue }, Mailer],
  exports: [JOB_QUEUE, Mailer],
})
export class JobsModule {}
