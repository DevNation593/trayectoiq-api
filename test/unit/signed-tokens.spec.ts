import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { SignedTokens, TokenError } from '../../src/shared/signed-tokens/signed-tokens.js';
import { FakeClock } from '../support/fake-clock.js';

const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_PEPPER: 'b'.repeat(32),
  PREVIEW_TOKEN_SECRET: 'c'.repeat(32),
});

const MINUTE = 60_000;
const USER = '0b0e2a52-7d0c-4f5c-9a43-0f3f3a8d2f10';
const OTHER = '9d6c1b7e-3f44-4a51-8a0e-5e2f0c6b7a11';

const reasonOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof TokenError) return error.reason;
    throw error;
  }
  return 'NO_ERROR';
};

describe('SignedTokens', () => {
  const setup = (): { clock: FakeClock; tokens: SignedTokens; expiresAt: Date } => {
    const clock = new FakeClock();
    return {
      clock,
      tokens: new SignedTokens(env, clock),
      expiresAt: new Date(clock.now().getTime() + 15 * MINUTE),
    };
  };
  const payload = { route: { tripDistanceMeters: 12000 }, pickup: { lat: -0.22, lng: -78.51 } };

  it('devuelve el contenido y el vencimiento de un token propio y vigente', async () => {
    const { tokens, expiresAt } = setup();
    const token = await tokens.sign('route', USER, payload, expiresAt);

    expect(await tokens.verify('route', token, USER)).toEqual({ payload, expiresAt });
  });

  it('vence en el instante indicado', async () => {
    const { tokens, clock, expiresAt } = setup();
    const token = await tokens.sign('route', USER, payload, expiresAt);

    clock.advance(15 * MINUTE - 1000);
    expect(await reasonOf(tokens.verify('route', token, USER))).toBe('NO_ERROR');
    clock.advance(2000);
    expect(await reasonOf(tokens.verify('route', token, USER))).toBe('expired');
  });

  it('rechaza el token de otro usuario', async () => {
    const { tokens, expiresAt } = setup();
    const token = await tokens.sign('route', USER, payload, expiresAt);
    expect(await reasonOf(tokens.verify('route', token, OTHER))).toBe('invalid');
  });

  it('rechaza un token usado para otro proposito', async () => {
    const { tokens, expiresAt } = setup();
    const token = await tokens.sign('route', USER, payload, expiresAt);
    expect(await reasonOf(tokens.verify('preview', token, USER))).toBe('invalid');
  });

  it('rechaza un token con el contenido alterado', async () => {
    const { tokens, expiresAt } = setup();
    const token = await tokens.sign('route', USER, payload, expiresAt);
    const [header, body, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as {
      data: { route: { tripDistanceMeters: number } };
    };
    decoded.data.route.tripDistanceMeters = 1;
    const forged = `${header}.${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`;

    expect(await reasonOf(tokens.verify('route', forged, USER))).toBe('invalid');
  });

  it('rechaza un token firmado con otra clave', async () => {
    const { clock, expiresAt } = setup();
    const foreign = new SignedTokens({ ...env, previewTokenSecret: 'z'.repeat(32) }, clock);
    const token = await foreign.sign('route', USER, payload, expiresAt);

    expect(await reasonOf(setup().tokens.verify('route', token, USER))).toBe('invalid');
  });

  it.each(['', 'no-es-un-token', 'a.b.c'])('rechaza %j', async (token) => {
    expect(await reasonOf(setup().tokens.verify('route', token, USER))).toBe('invalid');
  });

  it('un access token de la API no sirve como token de ruta', async () => {
    const { tokens, expiresAt } = setup();
    const withAccessSecret = new SignedTokens(
      { ...env, previewTokenSecret: env.jwtAccessSecret },
      new FakeClock(),
    );
    const token = await withAccessSecret.sign('route', USER, payload, expiresAt);
    expect(await reasonOf(tokens.verify('route', token, USER))).toBe('invalid');
  });
});
