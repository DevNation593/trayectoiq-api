import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

const valid = { DATABASE_URL: 'postgresql://user:pass@localhost:5432/db' };

describe('loadEnv', () => {
  it('aplica los valores por defecto cuando solo llega DATABASE_URL', () => {
    expect(loadEnv(valid)).toEqual({
      nodeEnv: 'development',
      port: 3000,
      databaseUrl: 'postgresql://user:pass@localhost:5432/db',
    });
  });

  it('lee NODE_ENV y PORT', () => {
    const env = loadEnv({ ...valid, NODE_ENV: 'production', PORT: '8080' });
    expect(env.nodeEnv).toBe('production');
    expect(env.port).toBe(8080);
  });

  it('falla nombrando la variable cuando falta DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it('trata un DATABASE_URL vacio como ausente', () => {
    expect(() => loadEnv({ DATABASE_URL: '  ' })).toThrow(/DATABASE_URL/);
  });

  it('rechaza un DATABASE_URL que no es de PostgreSQL', () => {
    expect(() => loadEnv({ DATABASE_URL: 'mysql://localhost/db' })).toThrow(/DATABASE_URL/);
  });

  it.each(['abc', '0', '70000', '3000.5', '-1'])('rechaza PORT=%s', (port) => {
    expect(() => loadEnv({ ...valid, PORT: port })).toThrow(/PORT/);
  });

  it('rechaza un NODE_ENV desconocido', () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: 'staging-ish' })).toThrow(/NODE_ENV/);
  });

  it('no incluye el valor de DATABASE_URL en el mensaje de error', () => {
    const secret = 'mysql://user:super-secreto@localhost/db';
    try {
      loadEnv({ DATABASE_URL: secret });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secreto');
    }
  });
});
