import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';

/** Tamano maximo de cuerpo: 06_SECURITY_PRIVACY.md seccion 5. */
const BODY_LIMIT_BYTES = 64 * 1024;

/** Rutas operativas que no llevan el prefijo de version. */
const UNVERSIONED_ROUTES = ['health', 'health/ready'];

/**
 * Construye la aplicacion con la misma configuracion en produccion y en tests,
 * para que los tests de extremo a extremo ejerciten lo que se despliega.
 */
export async function createApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: BODY_LIMIT_BYTES }),
    { bufferLogs: true },
  );
  app.setGlobalPrefix('v1', { exclude: UNVERSIONED_ROUTES });
  app.enableShutdownHooks();
  return app;
}
