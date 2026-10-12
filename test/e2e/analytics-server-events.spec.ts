import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, registerUser, type Session } from '../support/api.js';
import { fixture } from '../support/pricing-fixtures.js';
import {
  carolina,
  cumbaya,
  driver,
  freshRoute,
  plainInputs,
  plazaGrande,
  postQuote,
  previewed,
  previewQuote,
  routeOf,
  savedQuote,
} from '../support/quotes.js';
import { createTestApp, type TestApp } from '../support/test-app.js';
import { createVehicle, idempotencyKey, vehicleFromFixture } from '../support/vehicles.js';

interface EventRow {
  user_id: string | null;
  anonymous_id: string | null;
  event_name: string;
  event_version: number;
  properties: Record<string, unknown>;
  occurred_at: Date;
}

describe('eventos de servidor', () => {
  let test: TestApp;
  let db: pg.Pool;

  /** Deja pasar un segundo: el orden de los eventos de un test sale de su hora. */
  const tick = (): void => test.clock.advance(1000);
  /** Eventos del usuario con ese nombre, del mas antiguo al mas nuevo. */
  const events = async (session: Session, name?: string): Promise<EventRow[]> =>
    (
      await db.query(
        `SELECT * FROM analytics_events WHERE user_id = $1 AND ($2::text IS NULL OR event_name = $2)
         ORDER BY occurred_at, received_at, event_name`,
        [session.userId, name ?? null],
      )
    ).rows as EventRow[];
  const decide = (session: Session, quoteId: string, body: object) =>
    call(test, 'recordQuoteDecision', {
      token: session.accessToken,
      params: { quoteId },
      body,
      headers: idempotencyKey(),
    });

  beforeAll(async () => {
    test = await createTestApp();
    db = new pg.Pool({ connectionString: test.database.url, max: 2 });
  });
  afterAll(async () => {
    await db?.end();
    await test?.close();
  });

  describe('vehiculo', () => {
    it('crear un vehiculo deja vehicle_setup_completed', async () => {
      const session = await registerUser(test);
      await createVehicle(test, session, vehicleFromFixture('A_moto_10km_negotiate'));

      expect(await events(session)).toMatchObject([
        {
          event_name: 'vehicle_setup_completed',
          event_version: 1,
          anonymous_id: null,
          properties: {
            vehicle_type: 'MOTORCYCLE',
            has_maintenance_items: true,
            has_fixed_costs: true,
          },
          occurred_at: test.clock.now(),
        },
      ]);
    });

    it('sin mantenimientos ni costos fijos lo dice', async () => {
      const session = await registerUser(test);
      const body = vehicleFromFixture('A_moto_10km_negotiate', 'CAR');
      body.costProfile.maintenanceItems = [];
      body.costProfile.monthlyFixedCost = '0';
      await createVehicle(test, session, body);

      const [event] = await events(session, 'vehicle_setup_completed');
      expect(event!.properties).toEqual({
        vehicle_type: 'CAR',
        has_maintenance_items: false,
        has_fixed_costs: false,
      });
    });
  });

  describe('preview', () => {
    it('una ruta nueva deja quote_preview_requested y quote_preview_succeeded', async () => {
      const source = fixture('B_moto_pickup_wait_return_reject');
      const { session, vehicle } = await driver(test, source.name);
      test.routing.respondWith(routeOf(source));

      const preview = await previewQuote(test, session, {
        vehicleId: vehicle.id,
        pickupMode: 'CURRENT_LOCATION',
        currentLocation: cumbaya,
        pickup: plazaGrande,
        destination: carolina,
        ...source.quote,
      });

      expect(preview.status).toBe(200);
      const [requested] = await events(session, 'quote_preview_requested');
      expect(requested).toMatchObject({ event_version: 1, occurred_at: test.clock.now() });
      expect(requested!.properties).toEqual({
        vehicle_type: 'MOTORCYCLE',
        pickup_mode: 'CURRENT_LOCATION',
        has_offer: true,
        return_probability_bucket: '0.5',
        waiting_minutes_bucket: '1-5',
        plan: 'TRIAL',
      });
      const succeeded = await events(session, 'quote_preview_succeeded');
      expect(succeeded.map((event) => event.properties)).toEqual([
        {
          quote_request_id: preview.body.quoteRequestId,
          route_reused: false,
          routing_provider: 'fake',
          routing_profile: 'motorcycle',
          latency_ms: 0,
          recommendation: 'REJECT',
          has_offer: true,
          pricing_engine_version: '1.0.0',
        },
      ]);
      expect(await events(session, 'quote_preview_failed')).toEqual([]);
    });

    it('recalcular con routeToken se marca como ruta reutilizada y conserva el modo de recogida', async () => {
      const { session, vehicle } = await driver(test);
      const first = await previewed(test, session, vehicle);
      tick();

      const second = await previewQuote(test, session, {
        vehicleId: vehicle.id,
        routeToken: first.routeToken,
        ...plainInputs,
        waitingSeconds: 900,
      });

      const requested = await events(session, 'quote_preview_requested');
      expect(requested.map((event) => event.properties)).toEqual([
        {
          vehicle_type: 'MOTORCYCLE',
          pickup_mode: 'AT_PICKUP',
          has_offer: false,
          return_probability_bucket: '0',
          waiting_minutes_bucket: '0',
          plan: 'TRIAL',
        },
        {
          vehicle_type: 'MOTORCYCLE',
          pickup_mode: 'AT_PICKUP',
          has_offer: false,
          return_probability_bucket: '0',
          waiting_minutes_bucket: '11-15',
          plan: 'TRIAL',
        },
      ]);
      const succeeded = await events(session, 'quote_preview_succeeded');
      expect(succeeded.map((event) => event.properties)).toMatchObject([
        { quote_request_id: first.quoteRequestId, route_reused: false, recommendation: null },
        {
          quote_request_id: second.body.quoteRequestId,
          route_reused: true,
          routing_provider: 'fake',
          routing_profile: 'motorcycle',
          has_offer: false,
        },
      ]);
    });

    it('cada falla deja quote_preview_failed con su codigo y su etapa, y ningun exito', async () => {
      const { session, vehicle } = await driver(test);
      const body = { vehicleId: vehicle.id, ...freshRoute, ...plainInputs };

      test.routing.failNext('ROUTING_PROVIDER_UNAVAILABLE');
      expect((await previewQuote(test, session, body)).status).toBe(503);
      tick();
      expect(
        (
          await previewQuote(test, session, {
            ...body,
            destination: { lat: -2.1894, lng: -79.8891 },
          })
        ).status,
      ).toBe(422);
      tick();
      test.routing.respondWith({
        provider: 'fake',
        routingProfile: 'motorcycle',
        pickupDistanceMeters: 0,
        pickupDurationSeconds: 0,
        tripDistanceMeters: 2_147_483_648,
        tripDurationSeconds: 600,
      });
      expect((await previewQuote(test, session, body)).status).toBe(422);
      tick();
      expect(
        (await previewQuote(test, session, { vehicleId: vehicle.id, ...plainInputs })).status,
      ).toBe(422);
      tick();
      await db.query(
        `INSERT INTO quote_usage_counters (user_id, period_key, used) VALUES ($1, 'TRIAL', 10)
         ON CONFLICT (user_id, period_key) DO UPDATE SET used = 10`,
        [session.userId],
      );
      expect((await previewQuote(test, session, body)).status).toBe(402);

      const failed = await events(session, 'quote_preview_failed');
      expect(failed.map((event) => event.properties)).toEqual([
        {
          error_code: 'ROUTING_PROVIDER_UNAVAILABLE',
          stage: 'routing',
          routing_provider: 'fake',
          latency_ms: 0,
        },
        {
          error_code: 'OUT_OF_SERVICE_AREA',
          stage: 'routing',
          routing_provider: 'fake',
          latency_ms: 0,
        },
        {
          error_code: 'PRICING_INVALID_ROUTE',
          stage: 'pricing',
          routing_provider: 'fake',
          latency_ms: 0,
        },
        {
          error_code: 'QUOTE_INVALID_ROUTE_INPUT',
          stage: 'validation',
          routing_provider: null,
          latency_ms: 0,
        },
        { error_code: 'QUOTA_EXHAUSTED', stage: 'quota', routing_provider: 'fake', latency_ms: 0 },
      ]);
      expect(await events(session, 'quote_preview_succeeded')).toEqual([]);
    });

    it('con el correo sin verificar la falla es de validacion', async () => {
      const session = await registerUser(test, { verified: false });
      const other = await driver(test);

      const result = await previewQuote(test, session, {
        vehicleId: other.vehicle.id,
        ...freshRoute,
        ...plainInputs,
      });

      expect(result.status).toBe(403);
      expect((await events(session)).map((event) => event.properties)).toEqual([
        {
          error_code: 'EMAIL_NOT_VERIFIED',
          stage: 'validation',
          routing_provider: null,
          latency_ms: 0,
        },
      ]);
    });
  });

  describe('guardado y decision', () => {
    it('guardar deja quote_saved una sola vez aunque se repita', async () => {
      const { session, vehicle } = await driver(test);
      const preview = await previewed(test, session, vehicle, { offeredPrice: '4.00' });

      const saved = await postQuote(test, session, preview.previewToken);
      await postQuote(test, session, preview.previewToken);

      const rows = await events(session, 'quote_saved');
      expect(rows.map((event) => event.properties)).toEqual([
        {
          quote_id: saved.body.id,
          recommendation: saved.body.recommendation,
          pricing_engine_version: '1.0.0',
        },
      ]);
      expect(saved.body.recommendation).not.toBeNull();
    });

    it('cinco envios simultaneos del mismo preview dejan un solo quote_saved', async () => {
      const { session, vehicle } = await driver(test);
      const preview = await previewed(test, session, vehicle);

      await Promise.all(
        Array.from({ length: 5 }, () => postQuote(test, session, preview.previewToken)),
      );

      expect((await events(session, 'quote_saved')).length).toBe(1);
    });

    it('registrar la decision deja quote_decision_recorded, tambien al corregirla', async () => {
      const { session, vehicle } = await driver(test);
      const quote = await savedQuote(test, session, vehicle, { offeredPrice: '1.00' });
      expect(quote.recommendation).toBe('REJECT');

      await decide(session, quote.id, {
        action: 'NEGOTIATED_AND_ACCEPTED',
        finalPrice: '8.50',
        influence: 'YES',
        notes: 'Me recogio en la esquina de mi casa',
      });
      tick();
      await decide(session, quote.id, { action: 'REJECTED', influence: 'NO' });

      const rows = await events(session, 'quote_decision_recorded');
      expect(rows.map((event) => event.properties)).toEqual([
        {
          quote_id: quote.id,
          real_action: 'NEGOTIATED_AND_ACCEPTED',
          influence: 'YES',
          recommendation: 'REJECT',
          final_price_band: '8_TO_12',
          initial_offer_relation: 'BELOW_MIN',
        },
        {
          quote_id: quote.id,
          real_action: 'REJECTED',
          influence: 'NO',
          recommendation: 'REJECT',
          initial_offer_relation: 'BELOW_MIN',
        },
      ]);
    });

    it('sin oferta inicial la relacion es NO_OFFER y la recomendacion es null', async () => {
      const { session, vehicle } = await driver(test);
      const quote = await savedQuote(test, session, vehicle);

      await decide(session, quote.id, { action: 'UNKNOWN', influence: 'UNSURE' });

      const [event] = await events(session, 'quote_decision_recorded');
      expect(event!.properties).toEqual({
        quote_id: quote.id,
        real_action: 'UNKNOWN',
        influence: 'UNSURE',
        recommendation: null,
        initial_offer_relation: 'NO_OFFER',
      });
    });

    it('una decision rechazada por validacion no deja evento', async () => {
      const { session, vehicle } = await driver(test);
      const quote = await savedQuote(test, session, vehicle);

      await decide(session, quote.id, { action: 'NEGOTIATED_AND_ACCEPTED', influence: 'YES' });

      expect(await events(session, 'quote_decision_recorded')).toEqual([]);
    });
  });

  describe('privacidad', () => {
    it('ningun evento del flujo completo lleva coordenadas, lugares, notas, correo ni tokens', async () => {
      const { session, vehicle } = await driver(test);
      tick();
      const preview = await previewQuote(test, session, {
        vehicleId: vehicle.id,
        pickupMode: 'CURRENT_LOCATION',
        currentLocation: cumbaya,
        pickup: plazaGrande,
        destination: carolina,
        ...plainInputs,
        offeredPrice: '4.25',
      });
      tick();
      const saved = await postQuote(test, session, preview.body.previewToken);
      tick();
      await decide(session, saved.body.id, {
        action: 'NEGOTIATED_AND_ACCEPTED',
        finalPrice: '6.75',
        influence: 'YES',
        notes: 'nota privada del conductor',
      });

      const rows = await events(session);
      expect(rows.map((event) => event.event_name)).toEqual([
        'vehicle_setup_completed',
        'quote_preview_requested',
        'quote_preview_succeeded',
        'quote_saved',
        'quote_decision_recorded',
      ]);
      const text = JSON.stringify(rows.map((event) => event.properties));
      for (const secret of [
        '0.2201',
        '78.5123',
        '0.1807',
        '78.4841',
        '0.2003',
        '78.4313',
        'Plaza Grande',
        'Carolina',
        'nota privada',
        session.email,
        preview.body.routeToken,
        preview.body.previewToken,
        '4.25',
        '6.75',
      ]) {
        expect(text, secret).not.toContain(secret);
      }
      expect(text).not.toMatch(/"(lat|lng|label|notes|email)"/);
    });

    it('con analytics desactivado por el usuario solo quedan los eventos de operacion', async () => {
      const { session, vehicle } = await driver(test);
      await db.query('DELETE FROM analytics_events WHERE user_id = $1', [session.userId]);
      await db.query('UPDATE users SET analytics_opt_out = true WHERE id = $1', [session.userId]);

      const quote = await savedQuote(test, session, vehicle, { offeredPrice: '4.00' });
      await decide(session, quote.id, { action: 'REJECTED', influence: 'YES' });
      test.routing.failNext('ROUTING_PROVIDER_UNAVAILABLE');
      await previewQuote(test, session, { vehicleId: vehicle.id, ...freshRoute, ...plainInputs });

      expect((await events(session)).map((event) => event.event_name)).toEqual([
        'quote_preview_failed',
      ]);
    });
  });

  describe('si analytics falla', () => {
    it('crear vehiculo, cotizar, guardar y decidir terminan bien aunque no se pueda escribir el evento', async () => {
      const session = await registerUser(test);
      await db.query('ALTER TABLE analytics_events RENAME TO analytics_events_caida');
      try {
        const vehicle = await createVehicle(test, session);
        const preview = await previewQuote(test, session, {
          vehicleId: vehicle.id,
          ...freshRoute,
          ...plainInputs,
          offeredPrice: '4.00',
        });
        expect(preview.status).toBe(200);
        test.routing.failNext('ROUTING_PROVIDER_UNAVAILABLE');
        const failed = await previewQuote(test, session, {
          vehicleId: vehicle.id,
          ...freshRoute,
          ...plainInputs,
        });
        expect(failed.status).toBe(503);
        const saved = await postQuote(test, session, preview.body.previewToken);
        expect(saved.status).toBe(201);
        const decision = await decide(session, saved.body.id, {
          action: 'REJECTED',
          influence: 'YES',
        });
        expect(decision.status).toBe(200);
      } finally {
        await db.query('ALTER TABLE analytics_events_caida RENAME TO analytics_events');
      }
      expect(await events(session)).toEqual([]);
    });
  });
});
