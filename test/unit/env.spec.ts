import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

const valid = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_PEPPER: 'b'.repeat(32),
};

describe('loadEnv', () => {
  it('aplica los valores por defecto cuando solo llega DATABASE_URL', () => {
    expect(loadEnv(valid)).toEqual({
      nodeEnv: 'development',
      port: 3000,
      databaseUrl: 'postgresql://user:pass@localhost:5432/db',
      jwtAccessSecret: 'a'.repeat(32),
      jwtRefreshPepper: 'b'.repeat(32),
      smtpUrl: 'smtp://localhost:1025',
      emailFrom: 'TrayectoIQ <no-reply@trayectoiq.local>',
    });
  });

  it('lee NODE_ENV y PORT', () => {
    const env = loadEnv({ ...valid, NODE_ENV: 'test', PORT: '8080' });
    expect(env.nodeEnv).toBe('test');
    expect(env.port).toBe(8080);
  });

  it('falla nombrando la variable cuando falta DATABASE_URL', () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it('trata un DATABASE_URL vacio como ausente', () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: '  ' })).toThrow(/DATABASE_URL/);
  });

  it('rechaza un DATABASE_URL que no es de PostgreSQL', () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it.each(['abc', '0', '70000', '3000.5', '-1'])('rechaza PORT=%s', (port) => {
    expect(() => loadEnv({ ...valid, PORT: port })).toThrow(/PORT/);
  });

  it('rechaza un NODE_ENV desconocido', () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: 'staging-ish' })).toThrow(/NODE_ENV/);
  });

  it.each(['JWT_ACCESS_SECRET', 'JWT_REFRESH_PEPPER'])('exige %s', (name) => {
    expect(() => loadEnv({ ...valid, [name]: undefined })).toThrow(new RegExp(name));
  });

  it.each(['JWT_ACCESS_SECRET', 'JWT_REFRESH_PEPPER'])(
    'rechaza un %s de menos de 32 caracteres',
    (name) => {
      expect(() => loadEnv({ ...valid, [name]: 'corto' })).toThrow(new RegExp(name));
    },
  );

  it('rechaza usar el mismo valor para los dos secretos', () => {
    const same = 'x'.repeat(40);
    expect(() => loadEnv({ ...valid, JWT_ACCESS_SECRET: same, JWT_REFRESH_PEPPER: same })).toThrow(
      /distintos/,
    );
  });

  it('en produccion SMTP_URL y EMAIL_FROM son obligatorias', () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: 'production' })).toThrow(/SMTP_URL/);
    const env = loadEnv({
      ...valid,
      NODE_ENV: 'production',
      SMTP_URL: 'smtps://user:clave@smtp.example.com:465',
      EMAIL_FROM: 'TrayectoIQ <hola@trayectoiq.com>',
    });
    expect(env.smtpUrl).toBe('smtps://user:clave@smtp.example.com:465');
    expect(env.emailFrom).toBe('TrayectoIQ <hola@trayectoiq.com>');
  });

  it('rechaza un SMTP_URL que no es smtp:// ni smtps://', () => {
    expect(() => loadEnv({ ...valid, SMTP_URL: 'http://localhost' })).toThrow(/SMTP_URL/);
  });

  it('no incluye el valor de ningun secreto en el mensaje de error', () => {
    try {
      loadEnv({ ...valid, JWT_ACCESS_SECRET: 'secreto-corto', SMTP_URL: 'http://u:clave-smtp@h' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('secreto-corto');
      expect((error as Error).message).not.toContain('clave-smtp');
    }
  });

  it('no incluye el valor de DATABASE_URL en el mensaje de error', () => {
    const secret = 'mysql://user:super-secreto@localhost/db';
    try {
      loadEnv({ ...valid, DATABASE_URL: secret });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secreto');
    }
  });
});
