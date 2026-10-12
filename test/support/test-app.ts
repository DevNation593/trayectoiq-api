import type { Type } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { configureApp, fastifyOptions } from '../../src/app.factory.js';
import { AppModule } from '../../src/app.module.js';
import { APP_ENV } from '../../src/config/config.module.js';
import { type Env, loadEnv } from '../../src/config/env.js';
import { InlineJobQueue } from '../../src/modules/jobs/inline-job-queue.js';
import { JOB_QUEUE } from '../../src/modules/jobs/job-queue.js';
import { GEOCODING_PROVIDER } from '../../src/modules/places/places.controller.js';
import { FakeGeocodingProvider } from '../../src/modules/places/providers/fake-geocoding.provider.js';
import { FakeRoutingProvider } from '../../src/modules/routing/providers/fake-routing.provider.js';
import {
  buildRoutingProvider,
  ROUTING_PROVIDER,
} from '../../src/modules/routing/routing.module.js';
import { CLOCK } from '../../src/shared/clock/clock.js';
import { EMAIL_SENDER } from '../../src/shared/email/email-sender.js';
import { FakeEmailSender } from '../../src/shared/email/fake-email-sender.js';
import { FakeClock } from './fake-clock.js';
import { createMigratedDatabase, type TempDatabase } from './temp-database.js';

export interface TestApp {
  app: NestFastifyApplication;
  env: Env;
  clock: FakeClock;
  emails: FakeEmailSender;
  jobs: InlineJobQueue;
  /** Proveedor de rutas falso, detras de la misma comprobacion de area de servicio que en produccion. */
  routing: FakeRoutingProvider;
  geocoding: FakeGeocodingProvider;
  database: TempDatabase;
  close: () => Promise<void>;
}

export interface TestAppOptions {
  /** Controladores extra, solo para el test (por ejemplo, uno que lanza errores). */
  controllers?: Type[];
  /** Proveedores a sustituir, como pares [token, valor]. */
  overrides?: [token: unknown, value: unknown][];
}

/**
 * La aplicacion real, con la misma configuracion que produccion, sobre una base migrada propia.
 * Se sustituyen el reloj y el envio de correo, que el test necesita controlar y observar; la cola
 * de trabajos por una que los ejecuta al instante; y rutas y direcciones por proveedores
 * deterministas. La cola real y los adaptadores reales tienen sus propios tests.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const database = await createMigratedDatabase('app');
  const env = loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: database.url });
  const clock = new FakeClock();
  const emails = new FakeEmailSender();
  const jobs = new InlineJobQueue();
  const routing = new FakeRoutingProvider();
  const geocoding = new FakeGeocodingProvider();

  try {
    let builder = Test.createTestingModule({
      imports: [AppModule],
      controllers: options.controllers ?? [],
    });
    for (const [token, value] of options.overrides ?? []) {
      builder = builder.overrideProvider(token).useValue(value);
    }
    const moduleRef = await builder
      .overrideProvider(APP_ENV)
      .useValue(env)
      .overrideProvider(CLOCK)
      .useValue(clock)
      .overrideProvider(EMAIL_SENDER)
      .useValue(emails)
      .overrideProvider(JOB_QUEUE)
      .useValue(jobs)
      .overrideProvider(ROUTING_PROVIDER)
      .useValue(buildRoutingProvider(env, routing))
      .overrideProvider(GEOCODING_PROVIDER)
      .useValue(geocoding)
      .compile();

    const app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(fastifyOptions(env)),
    );
    configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    return {
      app,
      env,
      clock,
      emails,
      jobs,
      routing,
      geocoding,
      database,
      close: async () => {
        await app.close();
        await database.drop();
      },
    };
  } catch (error) {
    await database.drop();
    throw error;
  }
}
