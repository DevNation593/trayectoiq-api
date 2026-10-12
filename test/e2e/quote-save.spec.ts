import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, renewSession } from '../support/api.js';
import { fixture, golden } from '../support/pricing-fixtures.js';
import {
  carolina,
  cumbaya,
  driver,
  plainInputs,
  plazaGrande,
  postQuote,
  previewed,
  previewQuote,
  resultOf,
  routeOf,
} from '../support/quotes.js';
import { createTestApp, type TestApp } from '../support/test-app.js';
import { idempotencyKey, vehicleFromFixture } from '../support/vehicles.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('POST /quotes', () => {
  let test: TestApp;
  let db: pg.Pool;

  const quoteCount = async (userId: string): Promise<number> =>
    Number(
      (await db.query('SELECT count(*) AS n FROM quotes WHERE user_id = $1', [userId])).rows[0].n,
    );

  beforeAll(async () => {
    test = await createTestApp();
    db = new pg.Pool({ connectionString: test.database.url, max: 2 });
  });
  afterAll(async () => {
    await db?.end();
    await test?.close();
  });

  it('guarda el fixture B con los mismos valores que mostro el preview', async () => {
    const source = fixture('B_moto_pickup_wait_return_reject');
    const { session, vehicle } = await driver(test, source.name);
    test.routing.respondWith(routeOf(source));
    const preview = await previewQuote(test, session, {
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
    expect(preview.status).toBe(200);

    const { status, body } = await postQuote(test, session, preview.body.previewToken);

    expect(status).toBe(201);
    expect(resultOf(body)).toEqual(resultOf(preview.body));
    expect(body.pricing).toEqual({ floor: '3.27', minimum: '7.85', recommended: '8.85' });
    expect(body.recommendation).toBe('REJECT');
    expect(body.id).toMatch(UUID);
    expect(body).toMatchObject({
      createdAt: test.clock.now().toISOString(),
      vehicleId: vehicle.id,
      pickupLabel: 'Plaza Grande',
      destinationLabel: 'Parque La Carolina',
      waitingSeconds: 300,
      emptyReturnProbability: '0.5',
      decision: null,
    });
  });

  it('los 9 fixtures golden se guardan con los mismos valores que su preview', async () => {
    const { session, vehicle } = await driver(test);
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
      const preview = await previewQuote(test, session, {
        vehicleId: vehicle.id,
        pickupMode: hasPickup ? 'CURRENT_LOCATION' : 'AT_PICKUP',
        ...(hasPickup ? { currentLocation: cumbaya } : {}),
        pickup: plazaGrande,
        destination: carolina,
        ...source.quote,
      });
      expect(preview.status, source.name).toBe(200);

      const saved = await postQuote(test, session, preview.body.previewToken);

      expect(saved.status, `${source.name}: ${JSON.stringify(saved.body)}`).toBe(201);
      expect(resultOf(saved.body), source.name).toEqual(resultOf(preview.body));
      expect(saved.body.costs, source.name).toEqual(source.expected.api.costs);
      expect(saved.body.pricing, source.name).toEqual(source.expected.thresholds);
      expect(saved.body.earningsPerHour, source.name).toBe(source.expected.api.earningsPerHour);
      expect(saved.body.earningsPerKm, source.name).toBe(source.expected.api.earningsPerKm);
    }
  });

  it('sin oferta se guarda sin recomendacion ni ganancias', async () => {
    const { session, vehicle } = await driver(test);
    const preview = await previewed(test, session, vehicle);

    const { status, body } = await postQuote(test, session, preview.previewToken);

    expect(status).toBe(201);
    expect(body).toMatchObject({
      offeredPrice: null,
      recommendation: null,
      earningsPerHour: null,
      earningsPerKm: null,
    });
    expect(resultOf(body)).toEqual(resultOf(preview));
  });

  it('el precio ofrecido se devuelve con al menos dos decimales, igual en el preview y al guardar', async () => {
    const { session, vehicle } = await driver(test);
    for (const [sent, shown] of [
      ['7', '7.00'],
      ['7.5', '7.50'],
      ['7.125', '7.125'],
      ['7.100000', '7.10'],
    ] as const) {
      const preview = await previewed(test, session, vehicle, { offeredPrice: sent });
      expect(preview.offeredPrice, sent).toBe(shown);
      const saved = await postQuote(test, session, preview.previewToken);
      expect(saved.body.offeredPrice, sent).toBe(shown);
    }
  });

  it('un punto elegido en el mapa, sin nombre, se guarda sin etiqueta', async () => {
    const { session, vehicle } = await driver(test);
    const preview = await previewed(test, session, vehicle, {
      pickup: { lat: plazaGrande.lat, lng: plazaGrande.lng },
    });

    const { body } = await postQuote(test, session, preview.previewToken);

    expect(body).toMatchObject({ pickupLabel: null, destinationLabel: 'Parque La Carolina' });
  });

  it('persiste el id del preview, las coordenadas y el vencimiento de la ubicacion a 30 dias', async () => {
    const { session, vehicle } = await driver(test);
    const preview = await previewed(test, session, vehicle, { offeredPrice: '4.00' });

    const { body } = await postQuote(test, session, preview.previewToken);

    const { rows } = await db.query('SELECT * FROM quotes WHERE id = $1', [body.id]);
    expect(rows[0]).toMatchObject({
      user_id: session.userId,
      vehicle_id: vehicle.id,
      quote_request_id: preview.quoteRequestId,
      pricing_engine_version: '1.0.0',
      routing_provider: 'fake',
      routing_profile: 'motorcycle',
      pickup_lat: '-0.2201000',
      pickup_lng: '-78.5123000',
      destination_lat: '-0.1807000',
      destination_lng: '-78.4841000',
      pickup_label: 'Plaza Grande',
      destination_label: 'Parque La Carolina',
      offered_price: '4.000000',
    });
    expect(rows[0].created_at).toEqual(test.clock.now());
    expect(rows[0].exact_location_expires_at).toEqual(
      new Date(test.clock.now().getTime() + 30 * DAY),
    );
    const breakdown = await db.query('SELECT 1 FROM quote_cost_breakdowns WHERE quote_id = $1', [
      body.id,
    ]);
    expect(breakdown.rowCount).toBe(1);
  });

  it('la retencion de la ubicacion sale de app_config', async () => {
    const { session, vehicle } = await driver(test);
    await db.query(
      `INSERT INTO app_config (key, value) VALUES ('location_retention_days', '7'::jsonb)`,
    );
    try {
      const preview = await previewed(test, session, vehicle);
      const { body } = await postQuote(test, session, preview.previewToken);

      const { rows } = await db.query(
        'SELECT exact_location_expires_at FROM quotes WHERE id = $1',
        [body.id],
      );
      expect(rows[0].exact_location_expires_at).toEqual(
        new Date(test.clock.now().getTime() + 7 * DAY),
      );
    } finally {
      await db.query(`DELETE FROM app_config WHERE key = 'location_retention_days'`);
    }
  });

  it('guardar no consume cuota ni vuelve a pedir la ruta', async () => {
    const { session, vehicle } = await driver(test);
    const preview = await previewed(test, session, vehicle);
    const routesBefore = test.routing.calls.length;

    await postQuote(test, session, preview.previewToken);

    expect(test.routing.calls.length).toBe(routesBefore);
    const quota = await call<{ remaining: number }>(test, 'getQuoteQuota', {
      token: session.accessToken,
    });
    expect(quota.body.remaining).toBe(preview.quota.remaining);
  });

  describe('guardar dos veces el mismo preview', () => {
    it('devuelve la misma cotizacion y deja una sola fila', async () => {
      const { session, vehicle } = await driver(test);
      const preview = await previewed(test, session, vehicle, { offeredPrice: '5.00' });

      const first = await postQuote(test, session, preview.previewToken);
      test.clock.advance(MINUTE);
      const second = await postQuote(test, session, preview.previewToken);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body).toEqual(first.body);
      expect(await quoteCount(session.userId)).toBe(1);
    });

    it('cinco envios simultaneos con claves distintas dejan una sola cotizacion', async () => {
      const { session, vehicle } = await driver(test);
      const preview = await previewed(test, session, vehicle);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => postQuote(test, session, preview.previewToken)),
      );

      expect(results.map((result) => result.status)).toEqual([201, 201, 201, 201, 201]);
      expect(new Set(results.map((result) => result.body.id)).size).toBe(1);
      expect(await quoteCount(session.userId)).toBe(1);
    });

    it('dos recalculos sobre la misma ruta son dos cotizaciones distintas', async () => {
      const { session, vehicle } = await driver(test);
      const first = await previewed(test, session, vehicle, { offeredPrice: '4.00' });
      const second = await previewQuote(test, session, {
        vehicleId: vehicle.id,
        routeToken: first.routeToken,
        ...plainInputs,
        offeredPrice: '6.00',
      });

      const a = await postQuote(test, session, first.previewToken);
      const b = await postQuote(test, session, second.body.previewToken);

      expect(a.body.id).not.toBe(b.body.id);
      expect([a.body.offeredPrice, b.body.offeredPrice]).toEqual(['4.00', '6.00']);
      expect(await quoteCount(session.userId)).toBe(2);
    });
  });

  describe('tokens que no sirven', () => {
    it('vencido es 422 PREVIEW_TOKEN_EXPIRED y no guarda nada', async () => {
      const { session: first, vehicle } = await driver(test);
      const preview = await previewed(test, first, vehicle);

      test.clock.advance(15 * MINUTE - 1000);
      let session = await renewSession(test, first);
      const onTime = await postQuote(test, session, preview.previewToken);
      expect(onTime.status).toBe(201);

      const late = await previewed(test, session, vehicle);
      test.clock.advance(15 * MINUTE);
      session = await renewSession(test, session);
      const { status, body } = await postQuote(test, session, late.previewToken);

      expect(status).toBe(422);
      expect(body).toMatchObject({ code: 'PREVIEW_TOKEN_EXPIRED' });
      expect(await quoteCount(session.userId)).toBe(1);
    });

    it('alterado, de otra cuenta o de otro proposito es 422 PREVIEW_TOKEN_INVALID', async () => {
      const { session, vehicle } = await driver(test);
      const other = await driver(test);
      const preview = await previewed(test, session, vehicle);
      const [header, payload, signature] = preview.previewToken.split('.');
      const content = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as {
        data: { quote: { offeredPrice: string | null } };
      };
      content.data.quote.offeredPrice = '999';
      const tampered = [
        header,
        Buffer.from(JSON.stringify(content)).toString('base64url'),
        signature,
      ].join('.');

      const attempts = [
        await postQuote(test, session, tampered),
        await postQuote(test, other.session, preview.previewToken),
        await postQuote(test, session, preview.routeToken),
        await postQuote(test, session, 'esto-no-es-un-token'),
      ];

      for (const attempt of attempts) {
        expect(attempt.status).toBe(422);
        expect(attempt.body).toMatchObject({ code: 'PREVIEW_TOKEN_INVALID' });
      }
      expect(await quoteCount(session.userId)).toBe(0);
      expect(await quoteCount(other.session.userId)).toBe(0);
    });
  });

  describe('entradas y permisos', () => {
    it('exige sesion', async () => {
      const { status } = await call(test, 'saveQuote', {
        body: { previewToken: 'x' },
        headers: idempotencyKey(),
      });
      expect(status).toBe(401);
    });

    it('sin Idempotency-Key o sin previewToken es 422 VALIDATION_FAILED', async () => {
      const { session, vehicle } = await driver(test);
      const preview = await previewed(test, session, vehicle);

      const noKey = await postQuote(test, session, preview.previewToken, {});
      const noToken = await call(test, 'saveQuote', {
        token: session.accessToken,
        body: {},
        headers: idempotencyKey(),
      });

      expect(noKey.status).toBe(422);
      expect(noKey.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(noToken.status).toBe(422);
    });

    it('la misma Idempotency-Key repite la respuesta sin crear otra fila', async () => {
      const { session, vehicle } = await driver(test);
      const preview = await previewed(test, session, vehicle);
      const key = idempotencyKey();

      const first = await postQuote(test, session, preview.previewToken, key);
      const again = await postQuote(test, session, preview.previewToken, key);

      expect(again.status).toBe(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body).toEqual(first.body);
      expect(await quoteCount(session.userId)).toBe(1);
    });

    it('se puede guardar aunque el vehiculo se haya archivado despues de cotizar', async () => {
      const { session, vehicle } = await driver(test);
      const preview = await previewed(test, session, vehicle);
      await call(test, 'archiveVehicle', {
        token: session.accessToken,
        params: { vehicleId: vehicle.id },
      });

      const { status, body } = await postQuote(test, session, preview.previewToken);

      expect(status).toBe(201);
      expect(resultOf(body)).toEqual(resultOf(preview));
    });
  });
});
