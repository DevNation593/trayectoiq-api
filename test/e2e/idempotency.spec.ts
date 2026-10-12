import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Operation } from '../../src/shared/contract/contract.guard.js';
import { AppError } from '../../src/shared/errors/app-error.js';
import { registerUser, type Session } from '../support/api.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

let executions = 0;
let failNext = false;

/**
 * Controlador de prueba enlazado a una operacion real del contrato que exige Idempotency-Key.
 * La idempotencia se activa sola para toda operacion cuyo contrato declare esa cabecera.
 */
@Controller('test-idem')
class CountingController {
  @Post('quotes/:quoteId/decision')
  @HttpCode(200)
  @Operation('recordQuoteDecision')
  record(@Param('quoteId') quoteId: string, @Body() body: { action: string }): object {
    executions += 1;
    if (failNext) {
      failNext = false;
      throw new AppError(409, 'DECISION_LOCKED', 'La decision ya no se puede cambiar');
    }
    return { quoteId, action: body.action, execution: executions };
  }
}

const QUOTE = '0b0e2a52-7d0c-4f5c-9a43-0f3f3a8d2f10';
const HOUR = 60 * 60 * 1000;

describe('idempotencia', () => {
  let test: TestApp;
  let user: Session;

  const send = (
    key: string | undefined,
    body: object,
    session: Session = user,
  ): ReturnType<TestApp['app']['inject']> =>
    test.app.inject({
      method: 'POST',
      url: `/v1/test-idem/quotes/${QUOTE}/decision`,
      payload: body,
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        ...(key === undefined ? {} : { 'idempotency-key': key }),
      },
    });

  const rejected = { action: 'REJECTED', influence: 'YES' };
  let keyCounter = 0;
  const newKey = (): string => `clave-de-prueba-${String((keyCounter += 1)).padStart(6, '0')}`;

  beforeAll(async () => {
    test = await createTestApp({ controllers: [CountingController] });
    user = await registerUser(test);
  });
  beforeEach(() => {
    executions = 0;
    failNext = false;
  });
  afterAll(() => test?.close());

  it('la misma clave con el mismo cuerpo ejecuta una vez y repite la respuesta', async () => {
    const key = newKey();
    const first = await send(key, rejected);
    const second = await send(key, rejected);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(executions).toBe(1);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.headers['idempotent-replayed']).toBe('true');
  });

  it('la misma clave con otro cuerpo es 409 y no vuelve a ejecutar', async () => {
    const key = newKey();
    await send(key, rejected);
    const other = await send(key, { action: 'UNKNOWN', influence: 'NO' });

    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(executions).toBe(1);
  });

  it('claves distintas ejecutan por separado', async () => {
    await send(newKey(), rejected);
    await send(newKey(), rejected);
    expect(executions).toBe(2);
  });

  it('la misma clave en usuarios distintos no se mezcla', async () => {
    const other = await registerUser(test);
    const key = newKey();
    const mine = await send(key, rejected);
    const theirs = await send(key, rejected, other);

    expect(executions).toBe(2);
    expect(theirs.headers['idempotent-replayed']).toBeUndefined();
    expect(theirs.json()).not.toEqual(mine.json());
  });

  it('sin la cabecera la peticion es 422 y no ejecuta', async () => {
    const response = await send(undefined, rejected);
    expect(response.statusCode).toBe(422);
    expect(response.json().errors).toEqual([
      expect.objectContaining({ field: 'Idempotency-Key', code: 'required' }),
    ]);
    expect(executions).toBe(0);
  });

  it('una respuesta de error no se guarda: el reintento vuelve a ejecutar', async () => {
    const key = newKey();
    failNext = true;
    const failed = await send(key, rejected);
    const retried = await send(key, rejected);

    expect(failed.statusCode).toBe(409);
    expect(retried.statusCode).toBe(200);
    expect(executions).toBe(2);
  });

  it('cinco envios simultaneos con la misma clave ejecutan una sola vez', async () => {
    const key = newKey();
    const responses = await Promise.all(Array.from({ length: 5 }, () => send(key, rejected)));

    expect(executions).toBe(1);
    const statuses = responses.map((response) => response.statusCode);
    expect(statuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(1);
    // Las que llegaron mientras la primera seguia en curso reciben 409; ninguna otra cosa.
    expect(statuses.every((status) => status === 200 || status === 409)).toBe(true);
    for (const response of responses.filter((candidate) => candidate.statusCode === 200)) {
      expect(response.json().execution).toBe(1);
    }
  });

  it('la clave vence a las 24 horas', async () => {
    const key = newKey();
    await send(key, rejected);
    test.clock.advance(23 * HOUR);
    expect((await send(key, rejected, await relogin())).headers['idempotent-replayed']).toBe(
      'true',
    );
    test.clock.advance(2 * HOUR);
    const after = await send(key, rejected, await relogin());
    expect(after.headers['idempotent-replayed']).toBeUndefined();
    expect(executions).toBe(2);
  });

  /** El access token vence a los 15 minutos; tras avanzar el reloj hace falta una sesion nueva. */
  async function relogin(): Promise<Session> {
    const response = await test.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user.email, password: user.password },
      remoteAddress: `10.200.0.${(keyCounter += 1) % 250}`,
    });
    return { ...user, accessToken: response.json().accessToken };
  }
});
