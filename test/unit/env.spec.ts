import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

const valid = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_PEPPER: 'b'.repeat(32),
  PREVIEW_TOKEN_SECRET: 'c'.repeat(32),
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
      googleOauthClientIds: [],
      appleSigninAudience: null,
      previewTokenSecret: 'c'.repeat(32),
      routingProvider: 'fake',
      valhallaUrl: null,
      photonUrl: null,
      serviceAreaBbox: '-78.65,-0.45,-78.25,0.08',
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

  it.each(['JWT_ACCESS_SECRET', 'JWT_REFRESH_PEPPER', 'PREVIEW_TOKEN_SECRET'])(
    'exige %s',
    (name) => {
      expect(() => loadEnv({ ...valid, [name]: undefined })).toThrow(new RegExp(name));
    },
  );

  it.each(['JWT_ACCESS_SECRET', 'JWT_REFRESH_PEPPER', 'PREVIEW_TOKEN_SECRET'])(
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
      ROUTING_PROVIDER: 'valhalla',
      VALHALLA_URL: 'http://valhalla:8002',
      PHOTON_URL: 'http://photon:2322',
    });
    expect(env.smtpUrl).toBe('smtps://user:clave@smtp.example.com:465');
    expect(env.emailFrom).toBe('TrayectoIQ <hola@trayectoiq.com>');
  });

  it('rechaza un SMTP_URL que no es smtp:// ni smtps://', () => {
    expect(() => loadEnv({ ...valid, SMTP_URL: 'http://localhost' })).toThrow(/SMTP_URL/);
  });

  it('rechaza reutilizar un secreto para el token de preview', () => {
    expect(() => loadEnv({ ...valid, PREVIEW_TOKEN_SECRET: valid.JWT_ACCESS_SECRET })).toThrow(
      /distintos/,
    );
  });

  describe('rutas y direcciones', () => {
    const geo = {
      ROUTING_PROVIDER: 'valhalla',
      VALHALLA_URL: 'http://localhost:8002',
      PHOTON_URL: 'http://localhost:2322',
    };

    it('con valhalla lee las URL de Valhalla y de Photon', () => {
      const env = loadEnv({ ...valid, ...geo });
      expect(env).toMatchObject({
        routingProvider: 'valhalla',
        valhallaUrl: 'http://localhost:8002',
        photonUrl: 'http://localhost:2322',
      });
    });

    it.each(['VALHALLA_URL', 'PHOTON_URL'])('con valhalla exige %s', (name) => {
      expect(() => loadEnv({ ...valid, ...geo, [name]: undefined })).toThrow(new RegExp(name));
      expect(() => loadEnv({ ...valid, ...geo, [name]: 'localhost:8002' })).toThrow(
        new RegExp(name),
      );
    });

    it('rechaza un proveedor desconocido', () => {
      expect(() => loadEnv({ ...valid, ROUTING_PROVIDER: 'google' })).toThrow(/ROUTING_PROVIDER/);
    });

    it('en produccion no se puede usar el proveedor falso', () => {
      const production = {
        ...valid,
        NODE_ENV: 'production',
        SMTP_URL: 'smtps://u:p@smtp.example.com:465',
        EMAIL_FROM: 'TrayectoIQ <hola@trayectoiq.com>',
      };
      expect(() => loadEnv(production)).toThrow(/ROUTING_PROVIDER/);
      expect(() => loadEnv({ ...production, ROUTING_PROVIDER: 'fake' })).toThrow(
        /ROUTING_PROVIDER/,
      );
      expect(loadEnv({ ...production, ...geo }).routingProvider).toBe('valhalla');
    });

    it('valida el area de servicio', () => {
      expect(loadEnv({ ...valid, SERVICE_AREA_BBOX: '-79,-1,-78,0' }).serviceAreaBbox).toBe(
        '-79,-1,-78,0',
      );
      expect(() => loadEnv({ ...valid, SERVICE_AREA_BBOX: '1,2,3' })).toThrow(/SERVICE_AREA_BBOX/);
    });
  });

  it('lee los clientes de Google como lista y la audiencia de Apple', () => {
    const env = loadEnv({
      ...valid,
      GOOGLE_OAUTH_CLIENT_IDS:
        ' android.apps.googleusercontent.com , ios.apps.googleusercontent.com ',
      APPLE_SIGNIN_AUDIENCE: 'com.trayectoiq.app',
    });
    expect(env.googleOauthClientIds).toEqual([
      'android.apps.googleusercontent.com',
      'ios.apps.googleusercontent.com',
    ]);
    expect(env.appleSigninAudience).toBe('com.trayectoiq.app');
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
