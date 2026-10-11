import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { requestJson, UpstreamError } from '../../src/shared/http/upstream.js';
import { StubServer } from '../support/stub-server.js';

const kindOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof UpstreamError) return error.kind;
    throw error;
  }
  return 'NO_ERROR';
};

describe('requestJson', () => {
  const stub = new StubServer();
  let baseUrl: string;
  const options = { timeoutMs: 150, retries: 1 };

  beforeAll(async () => {
    baseUrl = await stub.start();
  });
  beforeEach(() => stub.reset());
  afterAll(() => stub.stop());

  it('devuelve estado y cuerpo JSON de una respuesta 200', async () => {
    stub.reply({ status: 200, body: { ok: true } });
    expect(await requestJson(`${baseUrl}/x`, {}, options)).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(stub.requests).toHaveLength(1);
  });

  it('envia metodo, cabeceras y cuerpo', async () => {
    stub.reply({ status: 200, body: {} });
    await requestJson(
      `${baseUrl}/route`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' },
      options,
    );
    expect(stub.requests[0]).toMatchObject({ method: 'POST', path: '/route', body: { a: 1 } });
  });

  it('una respuesta 4xx se devuelve tal cual y no se reintenta', async () => {
    stub.reply({ status: 400, body: { error_code: 171 } });
    expect(await requestJson(`${baseUrl}/x`, {}, options)).toEqual({
      status: 400,
      body: { error_code: 171 },
    });
    expect(stub.requests).toHaveLength(1);
  });

  it('reintenta una vez tras un 5xx y devuelve el exito', async () => {
    stub.reply({ status: 503, body: {} }, { status: 200, body: { ok: true } });
    expect((await requestJson(`${baseUrl}/x`, {}, options)).status).toBe(200);
    expect(stub.requests).toHaveLength(2);
  });

  it('tras agotar los reintentos con 5xx lanza un error de servidor con el estado', async () => {
    stub.reply({ status: 502, body: {} });
    const error = await requestJson(`${baseUrl}/x`, {}, options).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ kind: 'server', status: 502 });
    expect(stub.requests).toHaveLength(2);
  });

  it('con retries=0 no reintenta', async () => {
    stub.reply({ status: 500, body: {} });
    expect(await kindOf(requestJson(`${baseUrl}/x`, {}, { timeoutMs: 150, retries: 0 }))).toBe(
      'server',
    );
    expect(stub.requests).toHaveLength(1);
  });

  it('corta por timeout y reintenta; si vuelve a tardar, lanza timeout', async () => {
    stub.reply({ status: 200, body: {}, delayMs: 600 });
    const started = Date.now();
    expect(await kindOf(requestJson(`${baseUrl}/x`, {}, options))).toBe('timeout');
    expect(stub.requests).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(550);
  });

  it('un timeout seguido de una respuesta rapida termina bien', async () => {
    stub.reply({ status: 200, body: {}, delayMs: 600 }, { status: 200, body: { ok: true } });
    expect((await requestJson(`${baseUrl}/x`, {}, options)).body).toEqual({ ok: true });
  });

  it('un cuerpo 200 que no es JSON es una respuesta invalida y no se reintenta', async () => {
    stub.reply({ status: 200, body: '<html>no soy json</html>' });
    expect(await kindOf(requestJson(`${baseUrl}/x`, {}, options))).toBe('invalid');
    expect(stub.requests).toHaveLength(1);
  });

  it('un cuerpo 4xx que no es JSON se devuelve como texto', async () => {
    stub.reply({ status: 404, body: 'no encontrado' });
    expect(await requestJson(`${baseUrl}/x`, {}, options)).toEqual({
      status: 404,
      body: 'no encontrado',
    });
  });

  it('si no hay nadie escuchando lanza un error de red', async () => {
    const closed = new StubServer();
    const url = await closed.start();
    await closed.stop();
    expect(await kindOf(requestJson(`${url}/x`, {}, options))).toBe('network');
  });
});
