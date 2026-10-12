import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calculate } from '../../src/modules/pricing/domain/pricing-engine.js';
import type { EngineConfig, PricingInput } from '../../src/modules/pricing/domain/types.js';
import { call, type CallResult, type Session } from '../support/api.js';
import { fixture } from '../support/pricing-fixtures.js';
import {
  carolina,
  cumbaya,
  driver,
  plainInputs,
  plazaGrande,
  postQuote,
  previewed,
  previewQuote,
  routeOf,
  savedQuote,
  type SavedQuoteBody,
} from '../support/quotes.js';
import { createTestApp, type TestApp } from '../support/test-app.js';
import { vehicleFromFixture, type VehicleResponse } from '../support/vehicles.js';

interface Page {
  items: SavedQuoteBody[];
  nextCursor: string | null;
}

describe('historial de cotizaciones', () => {
  let test: TestApp;
  let db: pg.Pool;

  const getQuote = (session: Session, quoteId: string): Promise<CallResult<SavedQuoteBody>> =>
    call<SavedQuoteBody>(test, 'getQuote', { token: session.accessToken, params: { quoteId } });
  const listQuotes = (
    session: Session,
    query: Record<string, string> = {},
  ): Promise<CallResult<Page>> =>
    call<Page>(test, 'listQuotes', { token: session.accessToken, query });

  /**
   * Guarda `count` cotizaciones sobre una sola ruta (recalcular no consume cuota) y devuelve sus
   * ids de la mas antigua a la mas nueva. `tick` es el tiempo que pasa entre una y la siguiente.
   */
  const saveMany = async (
    session: Session,
    vehicle: VehicleResponse,
    count: number,
    tick = 1000,
  ): Promise<string[]> => {
    const first = await previewed(test, session, vehicle, { offeredPrice: '1.00' });
    const ids = [(await postQuote(test, session, first.previewToken)).body.id];
    for (let index = 1; index < count; index += 1) {
      // El limite de previews es de 20 por minuto por usuario.
      if (index % 15 === 0) test.clock.advance(61_000);
      test.clock.advance(tick);
      const next = await previewQuote(test, session, {
        vehicleId: vehicle.id,
        routeToken: first.routeToken,
        ...plainInputs,
        offeredPrice: `${index + 1}.00`,
      });
      expect(next.status, JSON.stringify(next.body)).toBe(200);
      const saved = await postQuote(test, session, next.body.previewToken);
      expect(saved.status, JSON.stringify(saved.body)).toBe(201);
      ids.push(saved.body.id);
    }
    return ids;
  };

  /** Recorre el historial completo de pagina en pagina. */
  const allPages = async (session: Session, limit: number): Promise<Page[]> => {
    const pages: Page[] = [];
    let cursor: string | null = null;
    do {
      const page: CallResult<Page> = await listQuotes(session, {
        limit: String(limit),
        ...(cursor ? { cursor } : {}),
      });
      expect(page.status, JSON.stringify(page.body)).toBe(200);
      pages.push(page.body);
      cursor = page.body.nextCursor;
    } while (cursor !== null && pages.length < 100);
    return pages;
  };

  beforeAll(async () => {
    test = await createTestApp();
    db = new pg.Pool({ connectionString: test.database.url, max: 2 });
  });
  afterAll(async () => {
    await db?.end();
    await test?.close();
  });

  describe('GET /quotes/{quoteId}', () => {
    it('devuelve exactamente lo que devolvio guardar', async () => {
      const { session, vehicle } = await driver(test);
      const saved = await savedQuote(test, session, vehicle, { offeredPrice: '4.00' });

      const { status, body } = await getQuote(session, saved.id);

      expect(status).toBe(200);
      expect(body).toEqual(saved);
    });

    it('la cotizacion de otra persona o una inexistente es 404', async () => {
      const owner = await driver(test);
      const other = await driver(test);
      const saved = await savedQuote(test, owner.session, owner.vehicle);

      const foreign = await getQuote(other.session, saved.id);
      const missing = await getQuote(owner.session, randomUUID());

      expect(foreign.status).toBe(404);
      expect(foreign.body).toMatchObject({ code: 'NOT_FOUND' });
      expect(missing.status).toBe(404);
    });

    it('un id que no es uuid es 422 y sin sesion es 401', async () => {
      const { session } = await driver(test);

      expect((await getQuote(session, 'no-es-un-uuid')).status).toBe(422);
      expect((await call(test, 'getQuote', { params: { quoteId: randomUUID() } })).status).toBe(
        401,
      );
    });
  });

  describe('inmutabilidad', () => {
    it('editar y archivar el vehiculo no cambia la cotizacion guardada', async () => {
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
      const saved = (await postQuote(test, session, preview.body.previewToken)).body;

      const edited = await call(test, 'updateVehicle', {
        token: session.accessToken,
        params: { vehicleId: vehicle.id },
        body: vehicleFromFixture('C_car_fixed_fee_accept', 'MOTORCYCLE'),
      });
      expect(edited.status).toBe(200);
      const afterEdit = await getQuote(session, saved.id);
      const archived = await call(test, 'archiveVehicle', {
        token: session.accessToken,
        params: { vehicleId: vehicle.id },
      });
      expect(archived.status).toBe(204);
      const afterArchive = await getQuote(session, saved.id);

      expect(afterEdit.body).toEqual(saved);
      expect(afterArchive.body).toEqual(saved);
      expect(saved.costs).toEqual(source.expected.api.costs);
      const listed = await listQuotes(session);
      expect(listed.body.items).toEqual([saved]);
    });

    it('el motor ejecutado sobre el snapshot guardado reproduce los valores guardados', async () => {
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
      const saved = (await postQuote(test, session, preview.body.previewToken)).body;
      // El vehiculo cambia despues de guardar: el snapshot no debe depender de el.
      await call(test, 'updateVehicle', {
        token: session.accessToken,
        params: { vehicleId: vehicle.id },
        body: vehicleFromFixture('A_moto_10km_negotiate'),
      });

      const { rows } = await db.query(
        `SELECT q.*, b.fuel_cost, b.maintenance_cost, b.tire_cost, b.depreciation_cost, b.fixed_cost,
                b.tolls_cost, b.parking_cost, b.other_cost, b.driver_target_compensation
         FROM quotes q JOIN quote_cost_breakdowns b ON b.quote_id = q.id WHERE q.id = $1`,
        [saved.id],
      );
      const row = rows[0] as Record<string, string | number | null> & {
        pricing_input_snapshot: {
          vehicleCostProfile: PricingInput['vehicleCostProfile'];
          engineConfig: EngineConfig;
        };
      };
      const input: PricingInput = {
        route: {
          pickupDistanceMeters: row.pickup_distance_meters as number,
          pickupDurationSeconds: row.pickup_duration_seconds as number,
          tripDistanceMeters: row.trip_distance_meters as number,
          tripDurationSeconds: row.trip_duration_seconds as number,
        },
        quote: {
          waitingSeconds: row.waiting_seconds as number,
          emptyReturnProbability: row.empty_return_probability as string,
          tollsAmount: row.tolls_amount as string,
          parkingAmount: row.parking_amount as string,
          otherDirectCostAmount: row.other_direct_cost_amount as string,
          offeredPrice: row.offered_price as string | null,
        },
        vehicleCostProfile: row.pricing_input_snapshot.vehicleCostProfile,
      };

      const result = calculate(input, row.pricing_input_snapshot.engineConfig);

      expect({
        operating: row.operating_cost_raw,
        fuel: row.fuel_cost,
        maintenance: row.maintenance_cost,
        tires: row.tire_cost,
        depreciation: row.depreciation_cost,
        fixed: row.fixed_cost,
        tolls: row.tolls_cost,
        parking: row.parking_cost,
        other: row.other_cost,
        targetCompensation: row.driver_target_compensation,
      }).toEqual(result.costsRaw);
      expect({
        floor: row.floor_price_raw,
        minimum: row.minimum_price_raw,
        recommended: row.recommended_price_raw,
      }).toEqual(result.pricesRaw);
      expect({
        floor: row.floor_price,
        minimum: row.minimum_price,
        recommended: row.recommended_price,
      }).toEqual(result.thresholds);
      expect(row.earnings_per_hour_raw).toBe(result.earningsPerHourRaw);
      expect(row.earnings_per_km_raw).toBe(result.earningsPerKmRaw);
      expect(row.recommendation).toBe(result.decision);
      // Y son los del fixture, no los del vehiculo ya editado.
      expect(result.costsRaw).toEqual(source.expected.costsRaw);
      expect(result.pricesRaw).toEqual(source.expected.pricesRaw);
    });
  });

  describe('GET /quotes', () => {
    it('sin cotizaciones devuelve una lista vacia', async () => {
      const { session } = await driver(test);

      const { status, body } = await listQuotes(session);

      expect(status).toBe(200);
      expect(body).toEqual({ items: [], nextCursor: null });
    });

    it('45 cotizaciones salen en paginas de 20, 20 y 5, de la mas nueva a la mas antigua', async () => {
      const { session, vehicle } = await driver(test);
      const ids = await saveMany(session, vehicle, 45);

      const pages = await allPages(session, 20);

      expect(pages.map((page) => page.items.length)).toEqual([20, 20, 5]);
      expect(pages.flatMap((page) => page.items.map((item) => item.id))).toEqual(
        [...ids].reverse(),
      );
      expect(pages[0]!.items[0]).toMatchObject({ offeredPrice: '45.00' });
      const whole = await listQuotes(session, { limit: '100' });
      expect(whole.body.items.length).toBe(45);
      expect(whole.body.nextCursor).toBeNull();
      const byDefault = await listQuotes(session);
      expect(byDefault.body.items.length).toBe(20);
      expect(byDefault.body.nextCursor).toBe(pages[0]!.nextCursor);
    });

    it('una pagina que termina justo en la ultima cotizacion no anuncia otra', async () => {
      const { session, vehicle } = await driver(test);
      await saveMany(session, vehicle, 4);

      const pages = await allPages(session, 2);

      expect(pages.map((page) => page.items.length)).toEqual([2, 2]);
    });

    it('guardar otra cotizacion a mitad del recorrido no repite ni omite ninguna', async () => {
      const { session, vehicle } = await driver(test);
      const ids = await saveMany(session, vehicle, 5);
      const first = await listQuotes(session, { limit: '2' });
      test.clock.advance(1000);
      await savedQuote(test, session, vehicle);

      const second = await listQuotes(session, { limit: '2', cursor: first.body.nextCursor! });
      const third = await listQuotes(session, { limit: '2', cursor: second.body.nextCursor! });

      expect(
        [first, second, third].flatMap((page) => page.body.items.map((item) => item.id)),
      ).toEqual([...ids].reverse());
      expect(third.body.nextCursor).toBeNull();
    });

    it('cotizaciones guardadas en el mismo instante se paginan sin perder ninguna', async () => {
      const { session, vehicle } = await driver(test);
      const ids = await saveMany(session, vehicle, 5, 0);

      const pages = await allPages(session, 2);

      const listed = pages.flatMap((page) => page.items.map((item) => item.id));
      expect(listed.length).toBe(5);
      expect(new Set(listed)).toEqual(new Set(ids));
    });

    it('solo lista las cotizaciones propias', async () => {
      const mine = await driver(test);
      const theirs = await driver(test);
      const own = await savedQuote(test, mine.session, mine.vehicle);
      await savedQuote(test, theirs.session, theirs.vehicle);

      const { body } = await listQuotes(mine.session);

      expect(body.items.map((item) => item.id)).toEqual([own.id]);
    });

    it('un cursor de otra persona no da acceso a sus cotizaciones', async () => {
      const mine = await driver(test);
      const theirs = await driver(test);
      await saveMany(theirs.session, theirs.vehicle, 3);
      const page = await listQuotes(theirs.session, { limit: '1' });

      const { status, body } = await listQuotes(mine.session, {
        cursor: page.body.nextCursor!,
      });

      expect(status).toBe(200);
      expect(body.items).toEqual([]);
    });

    it('el historial sigue disponible con la cuota agotada', async () => {
      const { session, vehicle } = await driver(test);
      const saved = await savedQuote(test, session, vehicle);
      await db.query(
        `INSERT INTO quote_usage_counters (user_id, period_key, used) VALUES ($1, 'TRIAL', 10)
         ON CONFLICT (user_id, period_key) DO UPDATE SET used = 10`,
        [session.userId],
      );
      const blocked = await previewQuote(test, session, {
        vehicleId: vehicle.id,
        pickupMode: 'AT_PICKUP',
        pickup: plazaGrande,
        destination: carolina,
        ...plainInputs,
      });
      expect(blocked.status).toBe(402);

      const listed = await listQuotes(session);
      const detail = await getQuote(session, saved.id);

      expect(listed.body.items.map((item) => item.id)).toEqual([saved.id]);
      expect(detail.status).toBe(200);
    });

    it('un cursor ilegible o un limite fuera de rango es 422 VALIDATION_FAILED', async () => {
      const { session } = await driver(test);

      const queries: Record<string, string>[] = [
        { cursor: 'no-es-un-cursor' },
        { cursor: Buffer.from('2026-10-12T15:00:00.000Z|no-es-uuid').toString('base64url') },
        { cursor: Buffer.from(`ayer|${randomUUID()}`).toString('base64url') },
        { limit: '0' },
        { limit: '101' },
        { limit: 'veinte' },
      ];
      for (const query of queries) {
        const { status, body } = await listQuotes(session, query);
        expect(status, JSON.stringify(query)).toBe(422);
        expect(body).toMatchObject({ code: 'VALIDATION_FAILED' });
      }
    });

    it('exige sesion', async () => {
      expect((await call(test, 'listQuotes')).status).toBe(401);
    });
  });
});
