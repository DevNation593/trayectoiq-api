import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, type CallResult, renewSession, type Session } from '../support/api.js';
import { type DecisionBody, driver, savedQuote, type SavedQuoteBody } from '../support/quotes.js';
import { createTestApp, type TestApp } from '../support/test-app.js';
import { idempotencyKey } from '../support/vehicles.js';

const HOUR = 60 * 60 * 1000;

describe('POST /quotes/{quoteId}/decision', () => {
  let test: TestApp;
  let db: pg.Pool;

  const decide = (
    session: Session,
    quoteId: string,
    body: unknown,
    headers: Record<string, string> = idempotencyKey(),
  ): Promise<CallResult<DecisionBody>> =>
    call<DecisionBody>(test, 'recordQuoteDecision', {
      token: session.accessToken,
      params: { quoteId },
      body,
      headers,
    });
  const getQuote = async (session: Session, quoteId: string): Promise<SavedQuoteBody> =>
    (
      await call<SavedQuoteBody>(test, 'getQuote', {
        token: session.accessToken,
        params: { quoteId },
      })
    ).body;
  const decisionRows = async (quoteId: string): Promise<Record<string, unknown>[]> =>
    (await db.query('SELECT * FROM quote_decisions WHERE quote_id = $1', [quoteId])).rows;
  /** Usuario con una cotizacion guardada; por defecto, con una oferta de 4.00. */
  const withQuote = async (
    inputs: object = { offeredPrice: '4.00' },
  ): Promise<{ session: Session; quote: SavedQuoteBody }> => {
    const { session, vehicle } = await driver(test);
    return { session, quote: await savedQuote(test, session, vehicle, inputs) };
  };

  beforeAll(async () => {
    test = await createTestApp();
    db = new pg.Pool({ connectionString: test.database.url, max: 2 });
  });
  afterAll(async () => {
    await db?.end();
    await test?.close();
  });

  it('registra que negocio y acepto, con precio final, influencia y nota', async () => {
    const { session: first, quote } = await withQuote();
    test.clock.advance(HOUR);
    const session = await renewSession(test, first);

    const { status, body } = await decide(session, quote.id, {
      action: 'NEGOTIATED_AND_ACCEPTED',
      finalPrice: '8.5',
      influence: 'YES',
      notes: 'Subio la oferta al ver el minimo',
    });

    expect(status).toBe(200);
    expect(body).toEqual({
      decidedAt: test.clock.now().toISOString(),
      action: 'NEGOTIATED_AND_ACCEPTED',
      finalPrice: '8.50',
      influence: 'YES',
      notes: 'Subio la oferta al ver el minimo',
    });
    expect((await getQuote(session, quote.id)).decision).toEqual(body);
    const listed = await call<{ items: SavedQuoteBody[] }>(test, 'listQuotes', {
      token: session.accessToken,
    });
    expect(listed.body.items[0]!.decision).toEqual(body);
    expect(await decisionRows(quote.id)).toMatchObject([
      { action: 'NEGOTIATED_AND_ACCEPTED', final_price: '8.500000', influence: 'YES' },
    ]);
  });

  it('acepta las acciones sin precio final: rechazo, cancelo la otra parte y no se sabe', async () => {
    for (const action of ['REJECTED', 'CANCELLED_BY_OTHER_PARTY', 'UNKNOWN']) {
      const { session, quote } = await withQuote();

      const { status, body } = await decide(session, quote.id, { action, influence: 'UNSURE' });

      expect(status, action).toBe(200);
      expect(body).toEqual({
        decidedAt: test.clock.now().toISOString(),
        action,
        finalPrice: null,
        influence: 'UNSURE',
      });
    }
  });

  it('acepto la oferta original: vale si la cotizacion tenia oferta', async () => {
    const { session, quote } = await withQuote({ offeredPrice: '4.00' });

    const { status, body } = await decide(session, quote.id, {
      action: 'ACCEPTED_ORIGINAL_OFFER',
      finalPrice: '4.00',
      influence: 'NO',
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ action: 'ACCEPTED_ORIGINAL_OFFER', finalPrice: '4.00' });
  });

  describe('corregir la decision', () => {
    it('un segundo envio dentro de las 24 horas reemplaza al primero por completo', async () => {
      const { session: first, quote } = await withQuote();
      await decide(first, quote.id, {
        action: 'NEGOTIATED_AND_ACCEPTED',
        finalPrice: '6.00',
        influence: 'YES',
        notes: 'primera version',
      });
      test.clock.advance(2 * HOUR);
      const session = await renewSession(test, first);

      const { status, body } = await decide(session, quote.id, {
        action: 'REJECTED',
        influence: 'NO',
      });

      expect(status).toBe(200);
      expect(body).toEqual({
        decidedAt: test.clock.now().toISOString(),
        action: 'REJECTED',
        finalPrice: null,
        influence: 'NO',
      });
      expect((await getQuote(session, quote.id)).decision).toEqual(body);
      const rows = await decisionRows(quote.id);
      expect(rows).toMatchObject([{ action: 'REJECTED', final_price: null, notes: null }]);
      expect(rows[0]!.updated_at).toEqual(test.clock.now());
    });

    it('justo a las 24 horas de guardar la cotizacion todavia se puede; despues es 409 DECISION_LOCKED', async () => {
      const { session: first, quote } = await withQuote();
      test.clock.advance(24 * HOUR);
      let session = await renewSession(test, first);
      const onTime = await decide(session, quote.id, { action: 'REJECTED', influence: 'YES' });
      expect(onTime.status).toBe(200);

      test.clock.advance(1);
      session = await renewSession(test, session);
      const late = await decide(session, quote.id, {
        action: 'NEGOTIATED_AND_ACCEPTED',
        finalPrice: '9.00',
        influence: 'NO',
      });

      expect(late.status).toBe(409);
      expect(late.body).toMatchObject({ code: 'DECISION_LOCKED' });
      expect((await getQuote(session, quote.id)).decision).toEqual(onTime.body);
    });

    it('pasadas las 24 horas tampoco se puede registrar una primera decision', async () => {
      const { session: first, quote } = await withQuote();
      test.clock.advance(24 * HOUR + 1000);
      const session = await renewSession(test, first);

      const { status, body } = await decide(session, quote.id, {
        action: 'REJECTED',
        influence: 'YES',
      });

      expect(status).toBe(409);
      expect(body).toMatchObject({ code: 'DECISION_LOCKED' });
      expect(await decisionRows(quote.id)).toEqual([]);
    });

    it('cinco envios simultaneos dejan una sola decision', async () => {
      const { session, quote } = await withQuote();

      const results = await Promise.all(
        Array.from({ length: 5 }, (_unused, index) =>
          decide(session, quote.id, {
            action: 'NEGOTIATED_AND_ACCEPTED',
            finalPrice: `${index + 5}.00`,
            influence: 'YES',
          }),
        ),
      );

      expect(results.map((result) => result.status)).toEqual([200, 200, 200, 200, 200]);
      const rows = await decisionRows(quote.id);
      expect(rows.length).toBe(1);
      expect(results.map((result) => result.body.finalPrice)).toContain(
        (await getQuote(session, quote.id)).decision!.finalPrice,
      );
    });
  });

  describe('reglas del precio final', () => {
    it('una accion de aceptacion sin precio final es 422, falte o venga en null', async () => {
      const { session, quote } = await withQuote();

      for (const body of [
        { action: 'NEGOTIATED_AND_ACCEPTED', influence: 'YES' },
        { action: 'NEGOTIATED_AND_ACCEPTED', influence: 'YES', finalPrice: null },
        { action: 'ACCEPTED_ORIGINAL_OFFER', influence: 'YES' },
      ]) {
        const result = await decide(session, quote.id, body);
        expect(result.status, JSON.stringify(body)).toBe(422);
        expect(result.body).toMatchObject({
          code: 'VALIDATION_FAILED',
          errors: [{ field: 'finalPrice', code: 'required' }],
        });
      }
      expect(await decisionRows(quote.id)).toEqual([]);
    });

    it('aceptar la oferta original de una cotizacion sin oferta es 422', async () => {
      const { session, quote } = await withQuote({});

      const { status, body } = await decide(session, quote.id, {
        action: 'ACCEPTED_ORIGINAL_OFFER',
        finalPrice: '4.00',
        influence: 'YES',
      });

      expect(status).toBe(422);
      expect(body).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [{ field: 'action', code: 'noOffer' }],
      });
      expect(await decisionRows(quote.id)).toEqual([]);
    });
  });

  describe('entradas y permisos', () => {
    it('la cotizacion de otra persona o una inexistente es 404', async () => {
      const owner = await withQuote();
      const other = await withQuote();
      const body = { action: 'REJECTED', influence: 'YES' };

      const foreign = await decide(other.session, owner.quote.id, body);
      const missing = await decide(owner.session, randomUUID(), body);

      expect(foreign.status).toBe(404);
      expect(foreign.body).toMatchObject({ code: 'NOT_FOUND' });
      expect(missing.status).toBe(404);
      expect(await decisionRows(owner.quote.id)).toEqual([]);
    });

    it('un cuerpo que no cumple el contrato es 422 VALIDATION_FAILED', async () => {
      const { session, quote } = await withQuote();

      for (const body of [
        { influence: 'YES' },
        { action: 'REJECTED' },
        { action: 'ME_ARREPENTI', influence: 'YES' },
        { action: 'REJECTED', influence: 'TAL_VEZ' },
        { action: 'REJECTED', influence: 'YES', finalPrice: '-1' },
        { action: 'REJECTED', influence: 'YES', notes: 'x'.repeat(501) },
        { action: 'REJECTED', influence: 'YES', decidedAt: '2020-01-01T00:00:00Z' },
      ]) {
        const result = await decide(session, quote.id, body);
        expect(result.status, JSON.stringify(body)).toBe(422);
        expect(result.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      }
      const noKey = await decide(session, quote.id, { action: 'REJECTED', influence: 'YES' }, {});
      expect(noKey.status).toBe(422);
      expect(await decisionRows(quote.id)).toEqual([]);
    });

    it('la misma Idempotency-Key repite la respuesta; con otro cuerpo es 409', async () => {
      const { session: initial, quote } = await withQuote();
      const key = idempotencyKey();
      const body = { action: 'REJECTED', influence: 'YES' };

      const first = await decide(initial, quote.id, body, key);
      test.clock.advance(HOUR);
      const session = await renewSession(test, initial);
      const again = await decide(session, quote.id, body, key);
      const changed = await decide(session, quote.id, { ...body, influence: 'NO' }, key);

      expect(again.status).toBe(200);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body).toEqual(first.body);
      expect(changed.status).toBe(409);
      expect(changed.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    });

    it('exige sesion', async () => {
      const { status } = await call(test, 'recordQuoteDecision', {
        params: { quoteId: randomUUID() },
        body: { action: 'REJECTED', influence: 'YES' },
        headers: idempotencyKey(),
      });
      expect(status).toBe(401);
    });
  });
});
