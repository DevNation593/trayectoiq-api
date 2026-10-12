import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RouteResult } from '../../src/modules/routing/domain/routing-provider.js';
import { call, type CallResult, registerUser, type Session } from '../support/api.js';
import { fixture, golden, type GoldenFixture } from '../support/pricing-fixtures.js';
import { createTestApp, type TestApp } from '../support/test-app.js';
import { createVehicle, vehicleFromFixture, type VehicleResponse } from '../support/vehicles.js';

const MINUTE = 60_000;
const plazaGrande = { lat: -0.2201, lng: -78.5123, label: 'Plaza Grande' };
const carolina = { lat: -0.1807, lng: -78.4841, label: 'Parque La Carolina' };
const cumbaya = { lat: -0.2003, lng: -78.4313 };
const guayaquil = { lat: -2.1894, lng: -79.8891 };

interface Preview {
  quoteRequestId: string;
  previewToken: string;
  routeToken: string;
  expiresAt: string;
  quota: { plan: string; remaining: number };
  pricingEngineVersion: string;
  currency: string;
  route: Record<string, unknown>;
  costs: Record<string, string>;
  pricing: { floor: string; minimum: string; recommended: string };
  offeredPrice: string | null;
  earningsPerHour: string | null;
  earningsPerKm: string | null;
  recommendation: string | null;
  disclaimer: string;
}

/** La ruta que devolveria el proveedor para las metricas de un fixture. */
const routeOf = (source: GoldenFixture, profile = 'motorcycle'): RouteResult => ({
  provider: 'fake',
  routingProfile: profile,
  ...source.route,
});

describe('POST /quotes/preview', () => {
  let test: TestApp;
  let db: pg.Pool;

  const quoteInputs = {
    waitingSeconds: 0,
    emptyReturnProbability: '0',
    tollsAmount: '0',
    parkingAmount: '0',
    otherDirectCostAmount: '0',
  };
  const freshRoute = { pickupMode: 'AT_PICKUP', pickup: plazaGrande, destination: carolina };

  const preview = (session: Session, body: object): Promise<CallResult<Preview>> =>
    call<Preview>(test, 'previewQuote', { token: session.accessToken, body });
  const remaining = async (session: Session): Promise<number> =>
    (await call<{ remaining: number }>(test, 'getQuoteQuota', { token: session.accessToken })).body
      .remaining;
  const setConfig = (key: string, value: unknown): Promise<unknown> =>
    db.query(
      `INSERT INTO app_config (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
  const clearConfig = (key: string): Promise<unknown> =>
    db.query('DELETE FROM app_config WHERE key = $1', [key]);
  /** Usuario verificado con un vehiculo (por defecto, el perfil del fixture A). */
  const driver = async (
    profile = 'A_moto_10km_negotiate',
  ): Promise<{ session: Session; vehicle: VehicleResponse }> => {
    const session = await registerUser(test);
    return { session, vehicle: await createVehicle(test, session, vehicleFromFixture(profile)) };
  };

  beforeAll(async () => {
    test = await createTestApp();
    db = new pg.Pool({ connectionString: test.database.url, max: 2 });
  });
  afterAll(async () => {
    await db?.end();
    await test?.close();
  });

  describe('ruta nueva', () => {
    it('reproduce el fixture B: recogida, espera, peaje y 50% de regreso vacio', async () => {
      const source = fixture('B_moto_pickup_wait_return_reject');
      const { session, vehicle } = await driver(source.name);
      test.routing.respondWith(routeOf(source));

      const { status, body, headers } = await preview(session, {
        vehicleId: vehicle.id,
        pickupMode: 'CURRENT_LOCATION',
        currentLocation: cumbaya,
        pickup: plazaGrande,
        destination: carolina,
        offeredPrice: '7.00',
        waitingSeconds: 300,
        emptyReturnProbability: '0.5',
        tollsAmount: '0.50',
        parkingAmount: '0.20',
        otherDirectCostAmount: '0',
      });

      expect(status).toBe(200);
      expect(body.pricing).toEqual({ floor: '3.27', minimum: '7.85', recommended: '8.85' });
      expect(body.recommendation).toBe('REJECT');
      expect(body.costs).toEqual(source.expected.api.costs);
      expect(body.earningsPerHour).toBe('3.67');
      expect(body.earningsPerKm).toBe('0.17');
      expect(body.offeredPrice).toBe('7.00');
      expect(body.route).toEqual({
        pickupDistanceMeters: 2000,
        pickupDurationSeconds: 300,
        tripDistanceMeters: 12000,
        tripDurationSeconds: 1800,
        effectiveDistanceMeters: 20000,
        effectiveDurationSeconds: 3300,
        returnMode: 'SYMMETRIC_ESTIMATE',
        routingProvider: 'fake',
        routingProfile: 'motorcycle',
      });
      expect(body).toMatchObject({ pricingEngineVersion: '1.0.0', currency: 'USD' });
      expect(body.disclaimer.length).toBeGreaterThan(20);
      expect(body.quota).toEqual({ plan: 'TRIAL', remaining: 9 });
      expect(headers['x-quote-request-id']).toBe(body.quoteRequestId);
      expect(body.expiresAt).toBe(new Date(test.clock.now().getTime() + 15 * MINUTE).toISOString());
    });

    it('los 9 fixtures golden dan el mismo resultado a traves de la API', async () => {
      const { session, vehicle } = await driver();
      for (const source of golden.fixtures) {
        const body = vehicleFromFixture(source.name);
        const replaced = await call(test, 'updateVehicle', {
          token: session.accessToken,
          params: { vehicleId: vehicle.id },
          body,
        });
        expect(replaced.status, source.name).toBe(200);
        test.routing.respondWith(routeOf(source, body.type === 'CAR' ? 'auto' : 'motorcycle'));
        const hasPickup = source.route.pickupDistanceMeters > 0;

        const result = await preview(session, {
          vehicleId: vehicle.id,
          pickupMode: hasPickup ? 'CURRENT_LOCATION' : 'AT_PICKUP',
          ...(hasPickup ? { currentLocation: cumbaya } : {}),
          pickup: plazaGrande,
          destination: carolina,
          ...source.quote,
        });

        expect(result.status, `${source.name}: ${JSON.stringify(result.body)}`).toBe(200);
        expect(result.body.pricing, source.name).toEqual(source.expected.thresholds);
        expect(result.body.recommendation, source.name).toBe(source.expected.decision);
        expect(result.body.costs, source.name).toEqual(source.expected.api.costs);
        expect(result.body.earningsPerHour, source.name).toBe(source.expected.api.earningsPerHour);
        expect(result.body.earningsPerKm, source.name).toBe(source.expected.api.earningsPerKm);
        expect(result.body.route, source.name).toMatchObject({
          effectiveDistanceMeters: source.expected.api.effectiveDistanceMeters,
          effectiveDurationSeconds: source.expected.api.effectiveDurationSeconds,
        });
      }
    });

    it('pide la ruta con el perfil del vehiculo; el origen solo va con CURRENT_LOCATION', async () => {
      const moto = await driver();
      await preview(moto.session, { vehicleId: moto.vehicle.id, ...freshRoute, ...quoteInputs });
      expect(test.routing.calls.at(-1)).toEqual({
        profile: 'MOTORCYCLE',
        pickup: { lat: plazaGrande.lat, lng: plazaGrande.lng },
        destination: { lat: carolina.lat, lng: carolina.lng },
      });

      const car = await driver('C_car_fixed_fee_accept');
      await preview(car.session, {
        vehicleId: car.vehicle.id,
        pickupMode: 'CURRENT_LOCATION',
        currentLocation: cumbaya,
        pickup: plazaGrande,
        destination: carolina,
        ...quoteInputs,
      });
      expect(test.routing.calls.at(-1)).toMatchObject({ profile: 'CAR', origin: cumbaya });
    });

    it('con AT_PICKUP la ubicacion actual se ignora aunque llegue: no hay tramo de recogida', async () => {
      const { session, vehicle } = await driver();

      const { status, body } = await preview(session, {
        vehicleId: vehicle.id,
        pickupMode: 'AT_PICKUP',
        currentLocation: cumbaya,
        pickup: plazaGrande,
        destination: carolina,
        ...quoteInputs,
      });

      expect(status).toBe(200);
      expect(test.routing.calls.at(-1)).not.toHaveProperty('origin');
      expect(body.route).toMatchObject({ pickupDistanceMeters: 0, pickupDurationSeconds: 0 });
    });

    it('acepta lugares por placeId', async () => {
      const { session, vehicle } = await driver();
      const suggest = async (q: string): Promise<string> =>
        (
          await call<{ id: string }[]>(test, 'autocompletePlaces', {
            token: session.accessToken,
            query: { q },
          })
        ).body[0]!.id;

      const result = await preview(session, {
        vehicleId: vehicle.id,
        pickupMode: 'AT_PICKUP',
        pickup: { placeId: await suggest('plaza grande') },
        destination: { placeId: await suggest('carolina') },
        ...quoteInputs,
      });

      expect(result.status).toBe(200);
      expect(test.routing.calls.at(-1)).toMatchObject({
        pickup: { lat: -0.2201, lng: -78.5123 },
        destination: { lat: -0.1807, lng: -78.4841 },
      });
    });

    it('sin oferta no hay recomendacion ni ganancias', async () => {
      const { session, vehicle } = await driver();
      const { body } = await preview(session, {
        vehicleId: vehicle.id,
        ...freshRoute,
        ...quoteInputs,
      });

      expect(body).toMatchObject({
        offeredPrice: null,
        recommendation: null,
        earningsPerHour: null,
        earningsPerKm: null,
      });
      expect(body.pricing.minimum).toMatch(/^\d+\.\d{2}$/);
    });

    it('el paso de redondeo del recomendado sale de app_config', async () => {
      const source = fixture('A_moto_10km_negotiate');
      const { session, vehicle } = await driver();
      await setConfig('pricing_recommended_step', '0.10');
      try {
        test.routing.respondWith(routeOf(source));
        const { body } = await preview(session, {
          vehicleId: vehicle.id,
          ...freshRoute,
          ...quoteInputs,
        });
        expect(body.pricing).toEqual({ floor: '1.25', minimum: '3.75', recommended: '4.30' });
      } finally {
        await clearConfig('pricing_recommended_step');
      }
    });

    it('los tokens no llevan la ubicacion actual del conductor', async () => {
      const { session, vehicle } = await driver();
      const { body } = await preview(session, {
        vehicleId: vehicle.id,
        pickupMode: 'CURRENT_LOCATION',
        currentLocation: { lat: -0.2003123, lng: -78.4313456 },
        pickup: plazaGrande,
        destination: carolina,
        ...quoteInputs,
      });

      for (const token of [body.routeToken, body.previewToken]) {
        const content = Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8');
        expect(content).not.toContain('2003123');
        expect(content).not.toContain('4313456');
      }
    });
  });

  describe('recalcular sin volver a rutear', () => {
    it('diez recalculos con ofertas distintas no consumen cuota ni llaman al proveedor', async () => {
      const source = fixture('A_moto_10km_negotiate');
      const { session, vehicle } = await driver();
      test.routing.respondWith(routeOf(source));
      const first = await preview(session, {
        vehicleId: vehicle.id,
        ...freshRoute,
        ...quoteInputs,
      });
      const callsAfterRoute = test.routing.calls.length;
      expect(await remaining(session)).toBe(9);

      const decisions: (string | null)[] = [];
      for (const offer of [
        '1.00',
        '3.74',
        '3.75',
        '4.00',
        '4.24',
        '4.25',
        '5.00',
        '9.99',
        '0',
        '4.25',
      ]) {
        const again = await preview(session, {
          vehicleId: vehicle.id,
          routeToken: first.body.routeToken,
          ...quoteInputs,
          offeredPrice: offer,
        });
        expect(again.status).toBe(200);
        expect(again.body.quota.remaining).toBe(9);
        expect(again.body.routeToken).toBe(first.body.routeToken);
        expect(again.body.expiresAt).toBe(first.body.expiresAt);
        expect(again.body.quoteRequestId).not.toBe(first.body.quoteRequestId);
        decisions.push(again.body.recommendation);
      }

      expect(decisions).toEqual([
        'REJECT',
        'REJECT',
        'NEGOTIATE',
        'NEGOTIATE',
        'NEGOTIATE',
        'ACCEPT',
        'ACCEPT',
        'ACCEPT',
        'REJECT',
        'ACCEPT',
      ]);
      expect(test.routing.calls.length).toBe(callsAfterRoute);
      expect(await remaining(session)).toBe(9);
    });

    it('recalcular con otra espera y otro regreso cambia tiempo y precios sobre la misma ruta', async () => {
      const { session, vehicle } = await driver();
      test.routing.respondWith(routeOf(fixture('A_moto_10km_negotiate')));
      const first = await preview(session, {
        vehicleId: vehicle.id,
        ...freshRoute,
        ...quoteInputs,
      });

      const again = await preview(session, {
        vehicleId: vehicle.id,
        routeToken: first.body.routeToken,
        ...quoteInputs,
        waitingSeconds: 600,
        emptyReturnProbability: '1',
      });

      expect(again.body.route).toMatchObject({
        tripDistanceMeters: 10000,
        effectiveDistanceMeters: 20000,
        effectiveDurationSeconds: 1800 + 1800 + 600,
      });
      expect(Number(again.body.pricing.minimum)).toBeGreaterThan(
        Number(first.body.pricing.minimum),
      );
    });

    it('con routeToken se ignoran pickup y destino del cuerpo', async () => {
      const { session, vehicle } = await driver();
      const first = await preview(session, {
        vehicleId: vehicle.id,
        ...freshRoute,
        ...quoteInputs,
      });
      const calls = test.routing.calls.length;

      const again = await preview(session, {
        vehicleId: vehicle.id,
        routeToken: first.body.routeToken,
        pickupMode: 'AT_PICKUP',
        pickup: guayaquil,
        destination: guayaquil,
        ...quoteInputs,
      });

      expect(again.status).toBe(200);
      expect(again.body.route).toEqual(first.body.route);
      expect(test.routing.calls.length).toBe(calls);
    });

    it('un routeToken alterado, ajeno o de otro tipo de vehiculo es 422 QUOTE_INVALID_ROUTE_INPUT', async () => {
      const moto = await driver();
      const first = await preview(moto.session, {
        vehicleId: moto.vehicle.id,
        ...freshRoute,
        ...quoteInputs,
      });
      const token = first.body.routeToken;

      const [header, payload, signature] = token.split('.');
      const forged = `${header}.${payload!.slice(0, -2)}AA.${signature}`;
      const tampered = await preview(moto.session, {
        vehicleId: moto.vehicle.id,
        routeToken: forged,
        ...quoteInputs,
      });
      expect(tampered.status).toBe(422);
      expect(tampered.body).toMatchObject({ code: 'QUOTE_INVALID_ROUTE_INPUT' });

      const other = await driver();
      const stolen = await preview(other.session, {
        vehicleId: other.vehicle.id,
        routeToken: token,
        ...quoteInputs,
      });
      expect(stolen.status).toBe(422);
      expect(stolen.body).toMatchObject({ code: 'QUOTE_INVALID_ROUTE_INPUT' });

      // La misma persona cambia su vehiculo a carro: la ruta de moto ya no sirve.
      await call(test, 'updateVehicle', {
        token: moto.session.accessToken,
        params: { vehicleId: moto.vehicle.id },
        body: vehicleFromFixture('C_car_fixed_fee_accept'),
      });
      const wrongProfile = await preview(moto.session, {
        vehicleId: moto.vehicle.id,
        routeToken: token,
        ...quoteInputs,
      });
      expect(wrongProfile.status).toBe(422);
      expect(wrongProfile.body).toMatchObject({ code: 'QUOTE_INVALID_ROUTE_INPUT' });
    });

    it('un routeToken vencido es 422 ROUTE_TOKEN_EXPIRED', async () => {
      const { session, vehicle } = await driver();
      const first = await preview(session, {
        vehicleId: vehicle.id,
        ...freshRoute,
        ...quoteInputs,
      });
      test.clock.advance(14 * MINUTE);
      const renewed = await call<{ accessToken: string }>(test, 'refreshSession', {
        body: { refreshToken: session.refreshToken },
      });
      const stillValid = await call(test, 'previewQuote', {
        token: renewed.body.accessToken,
        body: { vehicleId: vehicle.id, routeToken: first.body.routeToken, ...quoteInputs },
      });
      expect(stillValid.status).toBe(200);

      test.clock.advance(2 * MINUTE);
      const expired = await call(test, 'previewQuote', {
        token: renewed.body.accessToken,
        body: { vehicleId: vehicle.id, routeToken: first.body.routeToken, ...quoteInputs },
      });
      expect(expired.status).toBe(422);
      expect(expired.body).toMatchObject({ code: 'ROUTE_TOKEN_EXPIRED' });
    });
  });

  describe('cuota', () => {
    it('al agotarse responde 402 sin llamar al proveedor; recalcular con un routeToken vigente sigue funcionando', async () => {
      const { session, vehicle } = await driver();
      await setConfig('trial_quote_limit', 2);
      try {
        const first = await preview(session, {
          vehicleId: vehicle.id,
          ...freshRoute,
          ...quoteInputs,
        });
        const second = await preview(session, {
          vehicleId: vehicle.id,
          ...freshRoute,
          ...quoteInputs,
        });
        expect(second.body.quota.remaining).toBe(0);
        const calls = test.routing.calls.length;

        const third = await preview(session, {
          vehicleId: vehicle.id,
          ...freshRoute,
          ...quoteInputs,
        });
        expect(third.status).toBe(402);
        expect(third.body).toMatchObject({ code: 'QUOTA_EXHAUSTED' });
        expect(test.routing.calls.length).toBe(calls);

        const recalculated = await preview(session, {
          vehicleId: vehicle.id,
          routeToken: first.body.routeToken,
          ...quoteInputs,
          offeredPrice: '5.00',
        });
        expect(recalculated.status).toBe(200);
        expect(recalculated.body.quota.remaining).toBe(0);
      } finally {
        await clearConfig('trial_quote_limit');
      }
    });

    it('con el limite por defecto, la undecima ruta nueva del trial es 402', async () => {
      const { session, vehicle } = await driver();
      for (let route = 0; route < 10; route += 1) {
        const ok = await preview(session, { vehicleId: vehicle.id, ...freshRoute, ...quoteInputs });
        expect(ok.status).toBe(200);
      }
      const eleventh = await preview(session, {
        vehicleId: vehicle.id,
        ...freshRoute,
        ...quoteInputs,
      });
      expect(eleventh.status).toBe(402);
    });
  });

  describe('fallas de ruta: nunca consumen cuota', () => {
    it('proveedor caido es 503 ROUTING_PROVIDER_UNAVAILABLE', async () => {
      const { session, vehicle } = await driver();
      test.routing.failNext('ROUTING_PROVIDER_UNAVAILABLE');

      const { status, body } = await preview(session, {
        vehicleId: vehicle.id,
        ...freshRoute,
        ...quoteInputs,
      });

      expect(status).toBe(503);
      expect(body).toMatchObject({ code: 'ROUTING_PROVIDER_UNAVAILABLE' });
      expect(await remaining(session)).toBe(10);
    });

    it('sin ruta entre los puntos es 422 ROUTE_UNAVAILABLE', async () => {
      const { session, vehicle } = await driver();
      test.routing.failNext('ROUTE_UNAVAILABLE');

      const { status, body } = await preview(session, {
        vehicleId: vehicle.id,
        ...freshRoute,
        ...quoteInputs,
      });

      expect(status).toBe(422);
      expect(body).toMatchObject({ code: 'ROUTE_UNAVAILABLE' });
      expect(await remaining(session)).toBe(10);
    });

    it('un destino fuera del area de servicio es 422 OUT_OF_SERVICE_AREA sin llamar al proveedor', async () => {
      const { session, vehicle } = await driver();
      const calls = test.routing.calls.length;

      const { status, body } = await preview(session, {
        vehicleId: vehicle.id,
        pickupMode: 'AT_PICKUP',
        pickup: plazaGrande,
        destination: guayaquil,
        ...quoteInputs,
      });

      expect(status).toBe(422);
      expect(body).toMatchObject({ code: 'OUT_OF_SERVICE_AREA' });
      expect(test.routing.calls.length).toBe(calls);
      expect(await remaining(session)).toBe(10);
    });
  });

  describe('entradas y permisos', () => {
    it('con el correo sin verificar es 403 EMAIL_NOT_VERIFIED y no se rutea', async () => {
      const session = await registerUser(test, { verified: false });
      const vehicle = await createVehicle(test, session);
      const calls = test.routing.calls.length;

      const { status, body } = await preview(session, {
        vehicleId: vehicle.id,
        ...freshRoute,
        ...quoteInputs,
      });

      expect(status).toBe(403);
      expect(body).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
      expect(test.routing.calls.length).toBe(calls);
    });

    it('el vehiculo de otra persona, uno archivado o uno inexistente es 404, sin consumir cuota', async () => {
      const owner = await driver();
      const intruder = await registerUser(test);

      const foreign = await preview(intruder, {
        vehicleId: owner.vehicle.id,
        ...freshRoute,
        ...quoteInputs,
      });
      expect(foreign.status).toBe(404);
      expect(await remaining(intruder)).toBe(10);

      await call(test, 'archiveVehicle', {
        token: owner.session.accessToken,
        params: { vehicleId: owner.vehicle.id },
      });
      const archived = await preview(owner.session, {
        vehicleId: owner.vehicle.id,
        ...freshRoute,
        ...quoteInputs,
      });
      expect(archived.status).toBe(404);

      const missing = await preview(owner.session, {
        vehicleId: '0b0e2a52-7d0c-4f5c-9a43-0f3f3a8d2f10',
        ...freshRoute,
        ...quoteInputs,
      });
      expect(missing.status).toBe(404);
    });

    it.each([
      ['sin routeToken ni puntos', {}],
      ['con pickup pero sin destino', { pickupMode: 'AT_PICKUP', pickup: plazaGrande }],
      ['sin pickupMode', { pickup: plazaGrande, destination: carolina }],
      [
        'con CURRENT_LOCATION pero sin ubicacion actual',
        { pickupMode: 'CURRENT_LOCATION', pickup: plazaGrande, destination: carolina },
      ],
    ])('%s es 422 QUOTE_INVALID_ROUTE_INPUT', async (_name, route) => {
      const { session, vehicle } = await driver();
      const { status, body } = await preview(session, {
        vehicleId: vehicle.id,
        ...route,
        ...quoteInputs,
      });

      expect(status).toBe(422);
      expect(body).toMatchObject({ code: 'QUOTE_INVALID_ROUTE_INPUT' });
      expect(await remaining(session)).toBe(10);
    });

    it('un placeId que no emitio la API es 422 PLACE_NOT_FOUND', async () => {
      const { session, vehicle } = await driver();
      const { status, body } = await preview(session, {
        vehicleId: vehicle.id,
        pickupMode: 'AT_PICKUP',
        pickup: { placeId: 'inventado' },
        destination: carolina,
        ...quoteInputs,
      });
      expect(status).toBe(422);
      expect(body).toMatchObject({ code: 'PLACE_NOT_FOUND' });
    });

    it('un cuerpo que no cumple el contrato es 422 VALIDATION_FAILED', async () => {
      const { session, vehicle } = await driver();
      const { status, body } = await preview(session, {
        vehicleId: vehicle.id,
        ...freshRoute,
        ...quoteInputs,
        emptyReturnProbability: '0.3',
        tollsAmount: '-1',
      });
      expect(status).toBe(422);
      expect(body).toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('exige sesion', async () => {
      expect((await call(test, 'previewQuote', { body: {} })).status).toBe(401);
    });

    it('la peticion 21 en un minuto es 429', async () => {
      const { session, vehicle } = await driver();
      const first = await preview(session, {
        vehicleId: vehicle.id,
        ...freshRoute,
        ...quoteInputs,
      });
      const recalc = { vehicleId: vehicle.id, routeToken: first.body.routeToken, ...quoteInputs };
      for (let attempt = 0; attempt < 19; attempt += 1) {
        expect((await preview(session, recalc)).status).toBe(200);
      }
      expect((await preview(session, recalc)).status).toBe(429);
    });
  });
});
