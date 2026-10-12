import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MetricRow, runMetrics } from '../../scripts/metrics/run-metrics.js';
import { createMigratedDatabase, type TempDatabase } from '../support/temp-database.js';

/**
 * Las consultas de 08_ANALYTICS_VALIDATION.md seccion 4 sobre un conjunto de datos pequeno, armado
 * para que cada condicion de cada metrica tenga al menos un caso que la cumple y otro que no.
 */

const PERIOD = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-10-01T00:00:00Z') };
const IN_PERIOD = '2026-09-10T15:00:00Z';
const BEFORE_PERIOD = '2026-08-20T15:00:00Z';
const HOUR = 3_600_000;

/** Intervalo de Wilson del 95% en su forma de libro de texto, independiente de la del SQL. */
function wilson(numerator: number, denominator: number): { low: number; high: number } {
  const z = 1.959964;
  const p = numerator / denominator;
  const scale = 1 + (z * z) / denominator;
  const center = (p + (z * z) / (2 * denominator)) / scale;
  const half =
    (z * Math.sqrt((p * (1 - p)) / denominator + (z * z) / (4 * denominator * denominator))) /
    scale;
  return { low: center - half, high: center + half };
}

describe('consultas de metricas', () => {
  let database: TempDatabase;
  let pool: pg.Pool;
  let metrics: Record<string, MetricRow>;

  const user = async (createdAt = IN_PERIOD): Promise<{ id: string; vehicleId: string }> => {
    const id = randomUUID();
    await pool.query('INSERT INTO users (id, email, created_at) VALUES ($1, $2, $3)', [
      id,
      `${id}@example.com`,
      createdAt,
    ]);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO vehicles (user_id, type, fuel_type, fuel_efficiency_km_per_gallon)
       VALUES ($1, 'MOTORCYCLE', 'GASOLINE', 110) RETURNING id`,
      [id],
    );
    return { id, vehicleId: rows[0]!.id };
  };

  const event = (
    userId: string | null,
    name: string,
    occurredAt = IN_PERIOD,
    properties: object = {},
  ): Promise<unknown> =>
    pool.query(
      `INSERT INTO analytics_events (user_id, anonymous_id, event_name, properties, occurred_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [
        userId,
        userId ? null : 'instalacion-anonima-0001',
        name,
        JSON.stringify(properties),
        occurredAt,
      ],
    );

  interface QuoteSeed {
    /** Oferta inicial; null = cotizacion sin oferta. Minimo 5.00 y recomendado 6.00 en todas. */
    offered: string | null;
    createdAt?: string;
    decision?: {
      action: string;
      finalPrice?: string;
      influence: string;
      /** Horas despues de guardar la cotizacion. */
      afterHours?: number;
    };
  }

  const quote = async (owner: { id: string; vehicleId: string }, seed: QuoteSeed) => {
    const createdAt = seed.createdAt ?? IN_PERIOD;
    const recommendation =
      seed.offered === null
        ? null
        : Number(seed.offered) >= 6
          ? 'ACCEPT'
          : Number(seed.offered) >= 5
            ? 'NEGOTIATE'
            : 'REJECT';
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO quotes (
         user_id, vehicle_id, quote_request_id, pricing_engine_version, routing_provider, routing_profile,
         pricing_input_snapshot, trip_distance_meters, trip_duration_seconds, empty_return_probability,
         offered_price, operating_cost_raw, floor_price_raw, minimum_price_raw, recommended_price_raw,
         floor_price, minimum_price, recommended_price, recommendation, created_at)
       VALUES ($1, $2, $3, '1.0.0', 'fake', 'motorcycle', '{}'::jsonb, 10000, 1800, 0,
               $4, 1, 2, 5, 6, 2, 5, 6, $5, $6)
       RETURNING id`,
      [owner.id, owner.vehicleId, randomUUID(), seed.offered, recommendation, createdAt],
    );
    const quoteId = rows[0]!.id;
    if (seed.decision) {
      const decidedAt = new Date(
        new Date(createdAt).getTime() + (seed.decision.afterHours ?? 1) * HOUR,
      );
      await pool.query(
        `INSERT INTO quote_decisions (quote_id, action, final_price, influence, decided_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)`,
        [
          quoteId,
          seed.decision.action,
          seed.decision.finalPrice ?? null,
          seed.decision.influence,
          decidedAt,
        ],
      );
    }
    return quoteId;
  };

  beforeAll(async () => {
    database = await createMigratedDatabase('metrics');
    pool = new pg.Pool({ connectionString: database.url, max: 4 });

    const [u1, u2, u3, u4, u5, u6] = [
      await user(),
      await user(),
      await user(),
      await user(),
      await user(),
      await user(),
    ];
    const old = await user('2026-08-15T12:00:00Z');
    void u5; // registrado en el periodo, sin ninguna actividad

    // Activacion: hace falta el vehiculo Y un preview correcto.
    for (const activated of [u1!, u4!, u6!, old]) {
      await event(activated.id, 'vehicle_setup_completed');
    }
    await event(u2!.id, 'vehicle_setup_completed');

    // Actividad por dia en hora de Quito (UTC-5). u1: dos dias activos, 2 rutas nuevas.
    const newRoute = { route_reused: false };
    const reusedRoute = { route_reused: true };
    await event(u1!.id, 'app_opened', '2026-09-10T15:00:00Z');
    await event(u1!.id, 'quote_preview_succeeded', '2026-09-10T15:01:00Z', newRoute);
    await event(u1!.id, 'quote_preview_succeeded', '2026-09-10T15:02:00Z', reusedRoute);
    // 03:00 UTC del dia 11 son las 22:00 del dia 10 en Quito: sigue siendo el mismo dia activo.
    await event(u1!.id, 'quote_preview_succeeded', '2026-09-11T03:00:00Z', newRoute);
    await event(u1!.id, 'app_opened', '2026-09-12T15:00:00Z');
    // u3: un dia, 1 ruta nueva. u4: un dia, 3 rutas nuevas. u6: un dia, solo recalculos.
    await event(u3!.id, 'quote_preview_succeeded', IN_PERIOD, newRoute);
    for (let index = 0; index < 3; index += 1) {
      await event(u4!.id, 'quote_preview_succeeded', IN_PERIOD, newRoute);
    }
    await event(u6!.id, 'app_opened');
    await event(u6!.id, 'quote_preview_succeeded', IN_PERIOD, reusedRoute);
    // Fuera del periodo o sin usuario: no cuentan.
    await event(old.id, 'quote_preview_succeeded', BEFORE_PERIOD, newRoute);
    await event(null, 'app_opened');
    await event(u1!.id, 'quote_preview_failed', '2026-09-10T15:03:00Z', { stage: 'routing' });

    // Conversion: tres usuarios vieron el paywall; uno activo despues.
    for (const viewer of [u1!, u2!, u4!]) {
      await event(viewer.id, 'paywall_viewed', '2026-09-15T15:00:00Z');
    }
    await event(u1!.id, 'paywall_viewed', '2026-09-16T15:00:00Z');
    await event(null, 'paywall_viewed', '2026-09-15T15:00:00Z');
    await event(u1!.id, 'subscription_activated', '2026-09-17T15:00:00Z');
    await event(u6!.id, 'subscription_activated', '2026-09-17T15:00:00Z');
    // u2 tenia una suscripcion de antes de ver el paywall: no es una conversion de ese paywall.
    await event(u2!.id, 'subscription_activated', '2026-09-02T15:00:00Z');

    // Cotizaciones y decisiones. Minimo 5.00 y recomendado 6.00 en todas.
    await quote(u1!, {
      offered: '3',
      decision: { action: 'REJECTED', influence: 'YES' },
    });
    await quote(u1!, {
      offered: '7',
      decision: { action: 'ACCEPTED_ORIGINAL_OFFER', finalPrice: '7', influence: 'NO' },
    });
    await quote(u4!, {
      offered: '5.5',
      decision: { action: 'NEGOTIATED_AND_ACCEPTED', finalPrice: '6.5', influence: 'YES' },
    });
    await quote(u4!, {
      offered: '5.5',
      decision: { action: 'NEGOTIATED_AND_ACCEPTED', finalPrice: '4.5', influence: 'UNSURE' },
    });
    await quote(u6!, {
      offered: '3',
      decision: { action: 'NEGOTIATED_AND_ACCEPTED', finalPrice: '6', influence: 'NO' },
    });
    await quote(u6!, { offered: '7', decision: { action: 'UNKNOWN', influence: 'UNSURE' } });
    await quote(u6!, {
      offered: null,
      decision: { action: 'CANCELLED_BY_OTHER_PARTY', influence: 'NO' },
    });
    await quote(u1!, { offered: '7' });
    await quote(u1!, {
      offered: '7',
      decision: { action: 'NEGOTIATED_AND_ACCEPTED', finalPrice: '5.5', influence: 'YES' },
    });
    // Decision registrada fuera de las 24 horas (solo posible escribiendo en la base).
    await quote(u1!, {
      offered: '3',
      decision: { action: 'REJECTED', influence: 'YES', afterHours: 30 },
    });
    // Fuera del periodo.
    await quote(old, {
      offered: '3',
      createdAt: BEFORE_PERIOD,
      decision: { action: 'REJECTED', influence: 'YES' },
    });

    metrics = await runMetrics(pool, PERIOD);
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const expectProportion = (name: string, numerator: number, denominator: number): void => {
    const row = metrics[name];
    expect(row, name).toBeDefined();
    expect(row).toMatchObject({ metric: name, numerator, denominator });
    const interval = wilson(numerator, denominator);
    expect(Number(row!.rate)).toBeCloseTo(numerator / denominator, 4);
    expect(Number(row!.ci_low)).toBeCloseTo(interval.low, 4);
    expect(Number(row!.ci_high)).toBeCloseTo(interval.high, 4);
    expect(Number(row!.ci_low)).toBeLessThan(Number(row!.rate));
    expect(Number(row!.ci_high)).toBeGreaterThan(Number(row!.rate));
  };

  it('activation_rate: usuarios del periodo con vehiculo configurado y un preview correcto', () => {
    expectProportion('activation_rate', 3, 6);
  });

  it('decision_reporting_rate: cotizaciones del periodo con decision real en 24 horas', () => {
    // 10 cotizaciones; no cuentan la que no tiene decision, la UNKNOWN ni la decidida a las 30 horas.
    expectProportion('decision_reporting_rate', 7, 10);
  });

  it('decision_influence: decisiones en que la recomendacion influyo', () => {
    expectProportion('decision_influence', 4, 9);
  });

  it('decision_alignment_rate: decisiones alineadas con la recomendacion', () => {
    // Reportables: tenian recomendacion y la accion fue aceptar, negociar o rechazar (7).
    // Alineadas: REJECT rechazada (2), ACCEPT aceptada sobre el recomendado, NEGOTIATE cerrada sobre el minimo.
    expectProportion('decision_alignment_rate', 4, 7);
  });

  it('conversion_to_paid: usuarios que activaron una suscripcion despues de ver el paywall', () => {
    expectProportion('conversion_to_paid', 1, 3);
  });

  it('negotiation_lift: cuanto subio el precio final sobre la oferta inicial al negociar', () => {
    // (6.5-5.5)/5.5, (4.5-5.5)/5.5, (6-3)/3, (5.5-7)/7 -> -0.2143, -0.1818, 0.1818, 1
    const row = metrics.negotiation_lift!;
    expect(row).toMatchObject({ metric: 'negotiation_lift', sample_size: 4 });
    expect(Number(row.median)).toBeCloseTo((-1 / 5.5 + 1 / 5.5) / 2, 4);
    expect(Number(row.p25)).toBeCloseTo(-1.5 / 7 + 0.75 * (-1 / 5.5 + 1.5 / 7), 4);
    expect(Number(row.p75)).toBeCloseTo(1 / 5.5 + 0.25 * (1 - 1 / 5.5), 4);
  });

  it('recommendation_gap: distancia entre el precio final y el recomendado', () => {
    // (7-6)/6, (6.5-6)/6, (4.5-6)/6, (6-6)/6, (5.5-6)/6 -> -0.25, -0.0833, 0, 0.0833, 0.1667
    const row = metrics.recommendation_gap!;
    expect(row).toMatchObject({ metric: 'recommendation_gap', sample_size: 5 });
    expect(Number(row.median)).toBeCloseTo(0, 4);
    expect(Number(row.p25)).toBeCloseTo(-0.5 / 6, 4);
    expect(Number(row.p75)).toBeCloseTo(0.5 / 6, 4);
  });

  it('route_calculations_per_active_day: rutas nuevas por dia activo, en hora de Quito', () => {
    // u1: 2 rutas en 2 dias = 1; u3: 1; u4: 3; u6: 0 (solo recalculo).
    const row = metrics.route_calculations_per_active_day!;
    expect(row).toMatchObject({ metric: 'route_calculations_per_active_day', sample_size: 4 });
    expect(Number(row.median)).toBeCloseTo(1, 4);
    expect(Number(row.p25)).toBeCloseTo(0.75, 4);
    expect(Number(row.p75)).toBeCloseTo(1.5, 4);
  });

  it('successful_previews: el denominador del costo por cotizacion', () => {
    expect(metrics.successful_previews).toMatchObject({
      metric: 'successful_previews',
      successful_previews: 8,
      route_calculations: 6,
      route_reuses: 2,
    });
  });

  it('un periodo sin datos devuelve ceros y sin intervalo, no un error', async () => {
    const empty = await runMetrics(pool, {
      from: new Date('2020-01-01T00:00:00Z'),
      to: new Date('2020-02-01T00:00:00Z'),
    });

    expect(Object.keys(empty).sort()).toEqual(Object.keys(metrics).sort());
    expect(empty.activation_rate).toMatchObject({
      numerator: 0,
      denominator: 0,
      rate: null,
      ci_low: null,
      ci_high: null,
    });
    expect(empty.negotiation_lift).toMatchObject({ sample_size: 0, median: null });
  });
});
