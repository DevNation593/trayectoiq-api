import { expect } from 'vitest';
import { Contract } from '../../src/shared/contract/contract.js';
import type { TestApp } from './test-app.js';

const contract = Contract.load();
let ipCounter = 0;

/** Una IP distinta por llamada, para que los limites por IP no mezclen tests entre si. */
export const nextIp = (): string => {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
};

export interface CallOptions {
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, string>;
  /** Access token; se envia como bearer. */
  token?: string;
  headers?: Record<string, string>;
  /** IP de origen. Por defecto, una nueva en cada llamada. */
  ip?: string;
}

export interface CallResult<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | number | undefined>;
}

/**
 * Llama a una operacion del contrato por su operationId y comprueba que la respuesta cumple
 * el esquema que openapi.yaml declara para ese estado. Asi, cada test de extremo a extremo
 * es tambien una prueba de contrato.
 */
export async function call<T = Record<string, unknown>>(
  test: TestApp,
  operationId: string,
  options: CallOptions = {},
): Promise<CallResult<T>> {
  const operation = contract.operation(operationId);
  const path = operation.path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = options.params?.[name];
    if (value === undefined) throw new Error(`Falta el parametro de ruta ${name}`);
    return encodeURIComponent(value);
  });
  const query = options.query ? `?${new URLSearchParams(options.query).toString()}` : '';

  const response = await test.app.inject({
    method: operation.method.toUpperCase() as 'GET',
    url: `/v1${path}${query}`,
    payload: options.body as object | undefined,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    remoteAddress: options.ip ?? nextIp(),
  });

  const body = response.body === '' ? undefined : (response.json() as unknown);
  expect(
    contract.validateResponse(operationId, response.statusCode, body),
    `${operationId} respondio ${response.statusCode} con un cuerpo que no cumple el contrato: ${response.body}`,
  ).toEqual([]);

  return { status: response.statusCode, body: body as T, headers: response.headers };
}

export interface Session {
  email: string;
  password: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
}

let userCounter = 0;

/** El codigo de 6 digitos del ultimo correo enviado a esa direccion. */
export function lastCode(test: TestApp, email: string): string {
  const message = test.emails.lastTo(email);
  const code = message && /\b(\d{6})\b/.exec(message.text)?.[1];
  if (!code) throw new Error(`No hay correo con codigo para ${email}`);
  return code;
}

/** Registra un usuario nuevo y, salvo que se pida lo contrario, verifica su correo. */
export async function registerUser(
  test: TestApp,
  options: { email?: string; password?: string; verified?: boolean } = {},
): Promise<Session> {
  userCounter += 1;
  const email = options.email ?? `persona${userCounter}@example.com`;
  const password = options.password ?? 'clave-de-prueba-larga';

  const registered = await call<{
    accessToken: string;
    refreshToken: string;
    user: { id: string };
  }>(test, 'register', { body: { email, password } });
  expect(registered.status, JSON.stringify(registered.body)).toBe(201);

  if (options.verified !== false) {
    const verified = await call(test, 'verifyEmail', {
      token: registered.body.accessToken,
      body: { code: lastCode(test, email) },
    });
    expect(verified.status).toBe(204);
  }

  return {
    email,
    password,
    userId: registered.body.user.id,
    accessToken: registered.body.accessToken,
    refreshToken: registered.body.refreshToken,
  };
}
