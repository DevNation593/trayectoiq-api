import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { type Env, loadEnv } from './config/env.js';
import { loggerOptions } from './shared/observability/logger.js';

/** Tamano maximo de cuerpo: 06_SECURITY_PRIVACY.md seccion 5. */
const BODY_LIMIT_BYTES = 64 * 1024;

/** Rutas operativas que no llevan el prefijo de version. */
const UNVERSIONED_ROUTES = ['health', 'health/ready'];

export function fastifyOptions(env: Env): ConstructorParameters<typeof FastifyAdapter>[0] {
  return {
    bodyLimit: BODY_LIMIT_BYTES,
    // El traceId lo genera siempre el servidor: no se acepta uno impuesto por el cliente.
    genReqId: () => randomUUID(),
    logger: env.nodeEnv === 'test' ? false : loggerOptions(),
  };
}

/**
 * Configuracion comun a produccion y a los tests de extremo a extremo, para que estos
 * ejerciten exactamente lo que se despliega.
 */
export function configureApp(app: NestFastifyApplication): void {
  app.setGlobalPrefix('v1', { exclude: UNVERSIONED_ROUTES });
  app.enableShutdownHooks();
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (request, reply, done) => {
      void reply.header('x-trace-id', request.id);
      done();
    });
}

export async function createApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(fastifyOptions(loadEnv())),
    { bufferLogs: true },
  );
  configureApp(app);
  return app;
}
