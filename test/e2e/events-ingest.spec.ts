import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, type CallResult, nextIp, registerUser } from '../support/api.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

interface EventRow {
  user_id: string | null;
  anonymous_id: string | null;
  event_name: string;
  event_version: number;
  properties: Record<string, unknown>;
  occurred_at: Date;
  received_at: Date;
}

describe('POST /events', () => {
  let test: TestApp;
  let db: pg.Pool;

  /** Un id de instalacion nuevo: los limites y las consultas de cada test no se mezclan. */
  const installation = (): string => `inst-${randomUUID()}`;
  const send = (
    body: unknown,
    options: { token?: string; ip?: string } = {},
  ): Promise<CallResult<undefined>> => call<undefined>(test, 'ingestEvents', { body, ...options });
  const stored = async (anonymousId: string): Promise<EventRow[]> =>
    (
      await db.query(
        'SELECT * FROM analytics_events WHERE anonymous_id = $1 ORDER BY occurred_at, event_name',
        [anonymousId],
      )
    ).rows as EventRow[];
  const opened = (occurredAt = '2026-10-12T14:00:00.000Z'): object => ({
    name: 'app_opened',
    occurredAt,
    properties: { app_platform: 'ANDROID', app_version: '1.0.0' },
  });

  beforeAll(async () => {
    test = await createTestApp();
    db = new pg.Pool({ connectionString: test.database.url, max: 2 });
  });
  afterAll(async () => {
    await db?.end();
    await test?.close();
  });

  it('sin sesion guarda el lote con el id de instalacion', async () => {
    const anonymousId = installation();

    const { status, body } = await send({
      anonymousId,
      events: [
        opened('2026-10-12T14:00:00.000Z'),
        {
          name: 'onboarding_started',
          version: 2,
          occurredAt: '2026-10-12T14:00:05.000Z',
          properties: { acquisition_source: 'referido', app_platform: 'ANDROID' },
        },
      ],
    });

    expect(status).toBe(202);
    expect(body).toBeUndefined();
    expect(await stored(anonymousId)).toMatchObject([
      {
        user_id: null,
        event_name: 'app_opened',
        event_version: 1,
        properties: { app_platform: 'ANDROID', app_version: '1.0.0' },
        occurred_at: new Date('2026-10-12T14:00:00.000Z'),
        received_at: test.clock.now(),
      },
      {
        user_id: null,
        event_name: 'onboarding_started',
        event_version: 2,
        properties: { acquisition_source: 'referido', app_platform: 'ANDROID' },
        occurred_at: new Date('2026-10-12T14:00:05.000Z'),
      },
    ]);
  });

  it('con un bearer valido asocia los eventos al usuario', async () => {
    const session = await registerUser(test);
    const anonymousId = installation();

    const { status } = await send(
      { anonymousId, events: [opened()] },
      { token: session.accessToken },
    );

    expect(status).toBe(202);
    expect(await stored(anonymousId)).toMatchObject([
      { user_id: session.userId, event_name: 'app_opened' },
    ]);
  });

  it('con un bearer que ya no sirve guarda los eventos sin usuario en vez de perderlos', async () => {
    const session = await registerUser(test);
    await call(test, 'logout', { token: session.accessToken });
    const revoked = installation();
    const garbage = installation();

    const first = await send(
      { anonymousId: revoked, events: [opened()] },
      { token: session.accessToken },
    );
    const second = await send({ anonymousId: garbage, events: [opened()] }, { token: 'basura' });

    expect([first.status, second.status]).toEqual([202, 202]);
    expect(await stored(revoked)).toMatchObject([{ user_id: null }]);
    expect(await stored(garbage)).toMatchObject([{ user_id: null }]);
  });

  it('descarta el evento de nombre desconocido y guarda el resto del lote', async () => {
    const anonymousId = installation();

    const { status } = await send({
      anonymousId,
      events: [
        { name: 'evento_de_una_app_mas_nueva', occurredAt: '2026-10-12T14:00:00Z' },
        { name: 'quote_saved', occurredAt: '2026-10-12T14:00:00Z', properties: { quote_id: 'x' } },
        opened(),
      ],
    });

    expect(status).toBe(202);
    expect((await stored(anonymousId)).map((event) => event.event_name)).toEqual(['app_opened']);
  });

  it('de un evento permitido descarta las propiedades que no le corresponden', async () => {
    const anonymousId = installation();

    await send({
      anonymousId,
      events: [
        {
          name: 'paywall_viewed',
          occurredAt: '2026-10-12T14:00:00Z',
          properties: {
            trigger: 'TRIAL_EXHAUSTED',
            experiment_variant: 'B',
            lat: -0.2201,
            lng: -78.5123,
            email: 'ana@example.com',
            comentario: 'x'.repeat(200),
          },
        },
      ],
    });

    const [event] = await stored(anonymousId);
    expect(event!.properties).toEqual({ trigger: 'TRIAL_EXHAUSTED', experiment_variant: 'B' });
  });

  it('una fecha futura se guarda como la hora de llegada', async () => {
    const anonymousId = installation();
    const future = new Date(test.clock.now().getTime() + 3_600_000).toISOString();

    await send({ anonymousId, events: [opened(future)] });

    expect((await stored(anonymousId))[0]!.occurred_at).toEqual(test.clock.now());
  });

  it('no guarda nada de un usuario que desactivo analytics', async () => {
    const session = await registerUser(test);
    await db.query('UPDATE users SET analytics_opt_out = true WHERE id = $1', [session.userId]);
    const anonymousId = installation();

    const { status } = await send(
      { anonymousId, events: [opened()] },
      { token: session.accessToken },
    );

    expect(status).toBe(202);
    expect(await stored(anonymousId)).toEqual([]);
  });

  it('un lote de 50 entra y uno de 51 es 422 VALIDATION_FAILED', async () => {
    const full = installation();
    const tooBig = installation();
    const batch = (size: number): object[] => Array.from({ length: size }, () => opened());

    const accepted = await send({ anonymousId: full, events: batch(50) });
    const rejected = await send({ anonymousId: tooBig, events: batch(51) });

    expect(accepted.status).toBe(202);
    expect((await stored(full)).length).toBe(50);
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await stored(tooBig)).toEqual([]);
  });

  it('un lote mal formado es 422 VALIDATION_FAILED', async () => {
    const anonymousId = installation();
    const bodies: unknown[] = [
      { anonymousId, events: [] },
      { events: [opened()] },
      { anonymousId: 'corto', events: [opened()] },
      { anonymousId, events: [{ name: 'app_opened' }] },
      { anonymousId, events: [{ name: 'app_opened', occurredAt: 'ayer' }] },
      { anonymousId, events: [{ ...opened(), version: 0 }] },
      { anonymousId, events: [{ ...opened(), properties: { anidado: { lat: 1 } } }] },
      { anonymousId, events: [{ ...opened(), userId: randomUUID() }] },
    ];

    for (const body of bodies) {
      const result = await send(body);
      expect(result.status, JSON.stringify(body)).toBe(422);
      expect(result.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect(await stored(anonymousId)).toEqual([]);
  });

  it('el lote 11 de una instalacion en un minuto es 429; otra instalacion no se ve afectada', async () => {
    const anonymousId = installation();
    const body = { anonymousId, events: [opened()] };

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect((await send(body)).status, `lote ${attempt}`).toBe(202);
    }
    const blocked = await send(body);
    const other = await send({ anonymousId: installation(), events: [opened()] });

    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(other.status).toBe(202);

    test.clock.advance(60_000);
    expect((await send(body)).status).toBe(202);
  });

  it('cambiar de id de instalacion no evita el limite por direccion IP', async () => {
    const ip = nextIp();
    const statuses: number[] = [];

    for (let attempt = 1; attempt <= 121; attempt += 1) {
      statuses.push(
        (await send({ anonymousId: installation(), events: [opened()] }, { ip })).status,
      );
    }

    expect(statuses.slice(0, 120).every((status) => status === 202)).toBe(true);
    expect(statuses[120]).toBe(429);
  });

  it('si no se puede escribir en analytics responde 202 igual', async () => {
    const anonymousId = installation();
    await db.query('ALTER TABLE analytics_events RENAME TO analytics_events_caida');
    try {
      const { status } = await send({ anonymousId, events: [opened()] });
      expect(status).toBe(202);
    } finally {
      await db.query('ALTER TABLE analytics_events_caida RENAME TO analytics_events');
    }
    expect(await stored(anonymousId)).toEqual([]);
  });
});
