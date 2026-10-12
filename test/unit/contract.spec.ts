import { describe, expect, it } from 'vitest';
import { Contract } from '../../src/shared/contract/contract.js';

/** El contrato se carga una vez de contract/openapi.yaml: es el mismo documento que valida la API. */
const contract = Contract.load();

const fields = (errors: { field?: string }[]): (string | undefined)[] =>
  errors.map((error) => error.field).sort();

describe('Contract.validateRequest', () => {
  it('acepta un registro valido', () => {
    const errors = contract.validateRequest('register', {
      body: { email: 'ana@example.com', password: 'una-clave-larga' },
    });
    expect(errors).toEqual([]);
  });

  it('reporta el campo que falta', () => {
    const errors = contract.validateRequest('register', { body: { email: 'ana@example.com' } });
    expect(errors).toEqual([expect.objectContaining({ field: 'password', code: 'required' })]);
  });

  it('reporta formato y longitud, cada uno con su campo', () => {
    const errors = contract.validateRequest('register', {
      body: { email: 'no-es-email', password: 'corta' },
    });
    expect(fields(errors)).toEqual(['email', 'password']);
    expect(errors.find((error) => error.field === 'password')?.code).toBe('minLength');
    expect(errors.find((error) => error.field === 'email')?.code).toBe('format');
  });

  it('rechaza propiedades que el contrato no define', () => {
    const errors = contract.validateRequest('register', {
      body: { email: 'ana@example.com', password: 'una-clave-larga', role: 'ADMIN' },
    });
    expect(errors).toEqual([
      expect.objectContaining({ field: 'role', code: 'additionalProperties' }),
    ]);
  });

  it('rechaza propiedades desconocidas tambien en objetos anidados y en listas', () => {
    const errors = contract.validateRequest('ingestEvents', {
      body: {
        anonymousId: 'a'.repeat(20),
        events: [{ name: 'app_opened', occurredAt: '2026-10-11T10:00:00Z', extra: 1 }],
      },
    });
    expect(errors).toEqual([
      expect.objectContaining({ field: 'events[0].extra', code: 'additionalProperties' }),
    ]);
  });

  it('no rechaza claves libres donde el contrato las permite (additionalProperties)', () => {
    const errors = contract.validateRequest('ingestEvents', {
      body: {
        anonymousId: 'a'.repeat(20),
        events: [
          {
            name: 'app_opened',
            occurredAt: '2026-10-11T10:00:00Z',
            properties: { app_platform: 'ANDROID', cualquiera: true },
          },
        ],
      },
    });
    expect(errors).toEqual([]);
  });

  it('un cuerpo ausente cuando es obligatorio es un error', () => {
    expect(contract.validateRequest('login', {})).toEqual([
      expect.objectContaining({ code: 'required' }),
    ]);
  });

  it('una operacion sin cuerpo no exige nada', () => {
    expect(contract.validateRequest('getMe', {})).toEqual([]);
  });

  it('valida y convierte parametros de consulta', () => {
    expect(contract.validateRequest('listQuotes', { query: { limit: '20' } })).toEqual([]);
    expect(contract.validateRequest('listQuotes', { query: { limit: '500' } })).toEqual([
      expect.objectContaining({ field: 'limit', code: 'maximum' }),
    ]);
    expect(contract.validateRequest('listQuotes', { query: { limit: 'muchos' } })).toEqual([
      expect.objectContaining({ field: 'limit', code: 'type' }),
    ]);
  });

  it('exige los parametros de consulta obligatorios', () => {
    expect(contract.validateRequest('autocompletePlaces', { query: {} })).toEqual([
      expect.objectContaining({ field: 'q', code: 'required' }),
    ]);
  });

  it('valida parametros de ruta', () => {
    expect(contract.validateRequest('getVehicle', { params: { vehicleId: 'no-es-uuid' } })).toEqual(
      [expect.objectContaining({ field: 'vehicleId', code: 'format' })],
    );
  });

  it('exige la cabecera Idempotency-Key donde el contrato la pide', () => {
    const body = { previewToken: 'x' };
    expect(contract.validateRequest('saveQuote', { body, headers: {} })).toEqual([
      expect.objectContaining({ field: 'Idempotency-Key', code: 'required' }),
    ]);
    expect(
      contract.validateRequest('saveQuote', {
        body,
        headers: { 'idempotency-key': 'k'.repeat(16) },
      }),
    ).toEqual([]);
  });

  it('un decimal de dinero con punto es valido (regresion del patron mal escapado)', () => {
    const errors = contract.validateRequest('previewQuote', {
      body: {
        vehicleId: '0b0e2a52-7d0c-4f5c-9a43-0f3f3a8d2f10',
        routeToken: 'token',
        waitingSeconds: 0,
        emptyReturnProbability: '0.5',
        tollsAmount: '2.75',
        parkingAmount: '0',
        otherDirectCostAmount: '0',
      },
    });
    expect(errors).toEqual([]);
  });

  it('lanza si se pide una operacion que no existe en el contrato', () => {
    expect(() => contract.validateRequest('noExiste', {})).toThrow(/noExiste/);
  });
});

describe('Contract.validateResponse', () => {
  const problem = {
    type: 'https://api.trayectoiq.com/problems/not-found',
    title: 'No encontrado',
    status: 404,
    code: 'NOT_FOUND',
    traceId: 'abc',
  };

  it('acepta una respuesta que cumple el esquema', () => {
    expect(contract.validateResponse('getVehicle', 404, problem)).toEqual([]);
  });

  it('reporta lo que le falta a una respuesta', () => {
    const { traceId: _traceId, ...incomplete } = problem;
    expect(contract.validateResponse('getVehicle', 404, incomplete)).toEqual([
      expect.objectContaining({ field: 'traceId', code: 'required' }),
    ]);
  });

  it('un estado que el contrato no declara para esa operacion es un error', () => {
    expect(contract.validateResponse('getVehicle', 418, {})).toEqual([
      expect.objectContaining({ code: 'undeclaredStatus' }),
    ]);
  });

  it('una respuesta sin cuerpo declarado debe llegar vacia', () => {
    expect(contract.validateResponse('logout', 204, undefined)).toEqual([]);
    expect(contract.validateResponse('logout', 204, { sobra: true })).toEqual([
      expect.objectContaining({ code: 'unexpectedBody' }),
    ]);
  });
});

describe('Contract.operations', () => {
  it('conoce metodo y ruta de cada operacion', () => {
    expect(contract.operation('register')).toMatchObject({
      method: 'post',
      path: '/auth/register',
      public: true,
    });
    expect(contract.operation('getMe')).toMatchObject({
      method: 'get',
      path: '/me',
      public: false,
    });
  });
});
