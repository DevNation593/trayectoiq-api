import { Body, Controller, Get, Post } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Public } from '../../src/shared/auth/public.decorator.js';
import { Contract } from '../../src/shared/contract/contract.js';
import { AppError } from '../../src/shared/errors/app-error.js';
import { registerUser } from '../support/api.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

@Public()
@Controller('test')
class FailingController {
  @Get('boom')
  boom(): never {
    throw new Error('detalle interno: la clave es hunter2');
  }

  @Get('app-error')
  appError(): never {
    throw new AppError(409, 'EMAIL_ALREADY_REGISTERED', 'El correo ya esta registrado', {
      detail: 'Usa otro correo o inicia sesion.',
      errors: [{ field: 'email', code: 'unique', message: 'Ya existe' }],
    });
  }

  @Post('echo')
  echo(@Body() body: unknown): unknown {
    return body;
  }
}

@Controller('test-protegido')
class ProtectedController {
  /** A proposito no usa @CurrentAuth: la proteccion debe venir del guard, no del handler. */
  @Get()
  secret(): { secreto: string } {
    return { secreto: 'solo con sesion' };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('formato de error (ProblemDetails) y traceId', () => {
  let test: TestApp;
  const contract = Contract.load();

  beforeAll(async () => {
    test = await createTestApp({ controllers: [FailingController, ProtectedController] });
  });
  afterAll(() => test?.close());

  it('una ruta inexistente responde 404 NOT_FOUND como problem+json', async () => {
    const response = await test.app.inject({ method: 'GET', url: '/v1/no-existe' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({
      type: 'https://api.trayectoiq.com/problems/not-found',
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(response.json().traceId).toMatch(UUID);
  });

  it('un AppError conserva estado, codigo, titulo, detalle y errores por campo', async () => {
    const response = await test.app.inject({ method: 'GET', url: '/v1/test/app-error' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      type: 'https://api.trayectoiq.com/problems/email-already-registered',
      title: 'El correo ya esta registrado',
      status: 409,
      code: 'EMAIL_ALREADY_REGISTERED',
      detail: 'Usa otro correo o inicia sesion.',
      errors: [{ field: 'email', code: 'unique', message: 'Ya existe' }],
    });
  });

  it('un error inesperado responde 500 INTERNAL_ERROR sin filtrar el mensaje interno', async () => {
    const response = await test.app.inject({ method: 'GET', url: '/v1/test/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
    expect(response.body).not.toContain('hunter2');
    expect(response.body).not.toContain('detalle interno');
  });

  it('todo cuerpo de error cumple el esquema ProblemDetails del contrato', async () => {
    for (const url of ['/v1/no-existe', '/v1/test/app-error', '/v1/test/boom']) {
      const response = await test.app.inject({ method: 'GET', url });
      // getVehicle declara 404 con ProblemDetails: sirve para validar la forma de cualquier error.
      expect(contract.validateResponse('getVehicle', 404, response.json()), url).toEqual([]);
    }
  });

  it('un JSON mal formado responde 400 VALIDATION_FAILED', async () => {
    const response = await test.app.inject({
      method: 'POST',
      url: '/v1/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{ no es json',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('un cuerpo de mas de 64 KB responde 413 VALIDATION_FAILED', async () => {
    const response = await test.app.inject({
      method: 'POST',
      url: '/v1/test/echo',
      payload: { relleno: 'x'.repeat(70 * 1024) },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('cada respuesta lleva X-Trace-Id, igual al traceId del cuerpo de error y distinto por peticion', async () => {
    const first = await test.app.inject({ method: 'GET', url: '/v1/no-existe' });
    const second = await test.app.inject({ method: 'GET', url: '/health' });

    expect(first.headers['x-trace-id']).toBe(first.json().traceId);
    expect(second.headers['x-trace-id']).toMatch(UUID);
    expect(second.headers['x-trace-id']).not.toBe(first.headers['x-trace-id']);
  });

  it('no acepta un traceId impuesto por el cliente', async () => {
    const response = await test.app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-trace-id': 'elegido-por-el-cliente', 'x-request-id': 'tambien' },
    });

    expect(response.headers['x-trace-id']).toMatch(UUID);
  });

  it('una ruta sin @Public exige sesion aunque su handler no pida el usuario', async () => {
    const anonymous = await test.app.inject({ method: 'GET', url: '/v1/test-protegido' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ code: 'AUTH_TOKEN_EXPIRED' });
    expect(anonymous.body).not.toContain('solo con sesion');

    const session = await registerUser(test);
    const authenticated = await test.app.inject({
      method: 'GET',
      url: '/v1/test-protegido',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(authenticated.statusCode).toBe(200);
  });

  it('una respuesta correcta no se toca', async () => {
    const response = await test.app.inject({
      method: 'POST',
      url: '/v1/test/echo',
      payload: { hola: 'mundo' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ hola: 'mundo' });
  });
});
