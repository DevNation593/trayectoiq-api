import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UsageService } from '../../src/modules/usage/usage.service.js';
import { call, registerUser, type Session } from '../support/api.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

interface Quota {
  plan: 'TRIAL' | 'PRO';
  limit: number;
  used: number;
  remaining: number;
  resetAt: string | null;
}

const DAY = 24 * 60 * 60 * 1000;

describe('configuracion publica y cuota', () => {
  let test: TestApp;
  let db: pg.Pool;
  let usage: UsageService;

  const setConfig = (key: string, value: unknown): Promise<unknown> =>
    db.query(
      `INSERT INTO app_config (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
  const clearConfig = (key: string): Promise<unknown> =>
    db.query('DELETE FROM app_config WHERE key = $1', [key]);
  const subscribe = (session: Session, periodEnd: Date | null, active = true): Promise<unknown> =>
    db.query(
      `INSERT INTO subscriptions (user_id, provider, product_id, provider_subscription_id, status,
                                  entitlement_active, current_period_end)
       VALUES ($1, 'GOOGLE', 'pro_monthly', $2, 'ACTIVE', $3, $4)`,
      [session.userId, `sub-${session.userId}-${Math.random()}`, active, periodEnd],
    );
  const quota = (session: Session) =>
    call<Quota>(test, 'getQuoteQuota', { token: session.accessToken });

  beforeAll(async () => {
    test = await createTestApp();
    db = new pg.Pool({ connectionString: test.database.url, max: 2 });
    usage = test.app.get(UsageService);
  });
  afterAll(async () => {
    await db?.end();
    await test?.close();
  });

  describe('GET /app-config', () => {
    it('es publico y trae los valores por defecto', async () => {
      const { status, body } = await call(test, 'getAppConfig');

      expect(status).toBe(200);
      expect(body).toMatchObject({
        maintenanceMode: false,
        trialQuoteLimit: 10,
        minIosVersion: '1.0.0',
        minAndroidVersion: '1.0.0',
        publicFlags: {},
      });
    });

    it('incluye valores sugeridos de costos para moto y carro', async () => {
      const { body } = await call<{ costPresets: Record<string, Record<string, unknown>> }>(
        test,
        'getAppConfig',
      );

      for (const type of ['MOTORCYCLE', 'CAR']) {
        expect(body.costPresets[type], type).toMatchObject({
          fuelType: 'GASOLINE',
          fuelEfficiencyKmPerGallon: expect.stringMatching(/^\d+(\.\d+)?$/),
          costProfile: {
            fuelPricePerGallon: expect.any(String),
            targetHourlyIncome: expect.any(String),
            maintenanceItems: expect.any(Array),
          },
        });
      }
    });

    it('un cambio en app_config se ve en la siguiente peticion, sin desplegar', async () => {
      await setConfig('trial_quote_limit', 7);
      await setConfig('min_android_version', '1.4.0');
      await setConfig('maintenance_mode', true);
      await setConfig('cost_presets', { MOTORCYCLE: { fuelEfficiencyKmPerGallon: '95' } });
      try {
        const { body } = await call(test, 'getAppConfig');
        expect(body).toMatchObject({
          trialQuoteLimit: 7,
          minAndroidVersion: '1.4.0',
          maintenanceMode: true,
          costPresets: { MOTORCYCLE: { fuelEfficiencyKmPerGallon: '95' } },
        });
      } finally {
        for (const key of [
          'trial_quote_limit',
          'min_android_version',
          'maintenance_mode',
          'cost_presets',
        ]) {
          await clearConfig(key);
        }
      }
    });

    it('un valor guardado con el tipo equivocado no rompe nada: se usa el valor por defecto', async () => {
      await setConfig('trial_quote_limit', 'muchos');
      await setConfig('maintenance_mode', 'si');
      try {
        const { status, body } = await call(test, 'getAppConfig');
        expect(status).toBe(200);
        expect(body).toMatchObject({ trialQuoteLimit: 10, maintenanceMode: false });
      } finally {
        await clearConfig('trial_quote_limit');
        await clearConfig('maintenance_mode');
      }
    });
  });

  describe('GET /usage/quote-quota', () => {
    it('una cuenta nueva esta en trial con 10 rutas', async () => {
      const session = await registerUser(test);
      const { status, body } = await quota(session);
      expect(status).toBe(200);
      expect(body).toEqual({ plan: 'TRIAL', limit: 10, used: 0, remaining: 10, resetAt: null });
    });

    it('con una suscripcion activa es PRO con 300 al mes, y dice cuando se reinicia', async () => {
      const session = await registerUser(test);
      await subscribe(session, new Date(test.clock.now().getTime() + 20 * DAY));

      const { body } = await quota(session);

      // El reloj de pruebas arranca el 2026-10-12: el reinicio es el primer dia del mes siguiente, en UTC.
      expect(body).toEqual({
        plan: 'PRO',
        limit: 300,
        used: 0,
        remaining: 300,
        resetAt: '2026-11-01T00:00:00.000Z',
      });
    });

    it('una suscripcion vencida o inactiva no da Pro', async () => {
      const expired = await registerUser(test);
      await subscribe(expired, new Date(test.clock.now().getTime() - DAY));
      expect((await quota(expired)).body.plan).toBe('TRIAL');

      const inactive = await registerUser(test);
      await subscribe(inactive, null, false);
      expect((await quota(inactive)).body.plan).toBe('TRIAL');
    });

    it('exige sesion', async () => {
      expect((await call(test, 'getQuoteQuota')).status).toBe(401);
    });
  });

  describe('consumo de cuota', () => {
    it('consume una unidad por llamada y deja de conceder al llegar al limite', async () => {
      const session = await registerUser(test);
      await setConfig('trial_quote_limit', 2);
      try {
        expect(await usage.consumeRouteQuota(session.userId)).toMatchObject({
          allowed: true,
          plan: 'TRIAL',
          remaining: 1,
        });
        expect(await usage.consumeRouteQuota(session.userId)).toMatchObject({
          allowed: true,
          remaining: 0,
        });
        expect(await usage.consumeRouteQuota(session.userId)).toMatchObject({
          allowed: false,
          remaining: 0,
        });
        expect((await quota(session)).body).toMatchObject({ limit: 2, used: 2, remaining: 0 });
      } finally {
        await clearConfig('trial_quote_limit');
      }
    });

    it('con 20 peticiones simultaneas y 1 unidad disponible, exactamente una pasa', async () => {
      const session = await registerUser(test);
      await setConfig('trial_quote_limit', 1);
      try {
        const results = await Promise.all(
          Array.from({ length: 20 }, () => usage.consumeRouteQuota(session.userId)),
        );
        expect(results.filter((result) => result.allowed)).toHaveLength(1);
        expect((await quota(session)).body).toMatchObject({ used: 1, remaining: 0 });
      } finally {
        await clearConfig('trial_quote_limit');
      }
    });

    it('con limite 0 no concede nada', async () => {
      const session = await registerUser(test);
      await setConfig('trial_quote_limit', 0);
      try {
        expect((await usage.consumeRouteQuota(session.userId)).allowed).toBe(false);
      } finally {
        await clearConfig('trial_quote_limit');
      }
    });

    it('devolver una unidad la deja disponible otra vez, sin bajar de cero', async () => {
      const session = await registerUser(test);
      const consumed = await usage.consumeRouteQuota(session.userId);
      await usage.refundRouteQuota(session.userId, consumed.periodKey);
      await usage.refundRouteQuota(session.userId, consumed.periodKey);

      expect((await quota(session)).body).toMatchObject({ used: 0, remaining: 10 });
    });

    it('la cuota Pro es mensual: al cambiar de mes vuelve a cero', async () => {
      const session = await registerUser(test);
      await subscribe(session, new Date(test.clock.now().getTime() + 90 * DAY));
      await usage.consumeRouteQuota(session.userId);
      await usage.consumeRouteQuota(session.userId);
      const october = await usage.quota(session.userId);
      expect(october).toMatchObject({ plan: 'PRO', used: 2, remaining: 298 });

      test.clock.advance(25 * DAY); // 2026-11-06

      expect(await usage.quota(session.userId)).toMatchObject({
        plan: 'PRO',
        used: 0,
        remaining: 300,
        resetAt: new Date('2026-12-01T00:00:00.000Z'),
      });
    });

    it('lo consumido en trial no cuenta contra la cuota Pro', async () => {
      const session = await registerUser(test);
      await usage.consumeRouteQuota(session.userId);
      await subscribe(session, null);
      expect(await usage.quota(session.userId)).toMatchObject({ plan: 'PRO', used: 0 });
    });
  });
});
