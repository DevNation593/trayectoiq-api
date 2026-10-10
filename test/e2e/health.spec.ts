import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.factory.js';
import { DatabaseService } from '../../src/shared/database/database.service.js';

describe('salud de la API', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health responde 200 sin tocar la base', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('GET /health/ready responde 200 con la base conectada', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { database: 'up' } });
  });

  it('GET /health/ready responde 503 si la base no contesta', async () => {
    const database = app.get(DatabaseService);
    const original = database.ping.bind(database);
    database.ping = () => Promise.reject(new Error('connection refused'));
    try {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: 'unavailable', checks: { database: 'down' } });
    } finally {
      database.ping = original;
    }
  });

  it('los endpoints de salud quedan fuera del prefijo /v1', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(response.statusCode).toBe(404);
  });
});
