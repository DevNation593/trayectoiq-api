import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, registerUser, type Session } from '../support/api.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

interface Suggestion {
  id: string;
  label: string;
  secondaryLabel?: string;
}

describe('lugares', () => {
  let test: TestApp;
  let user: Session;

  const autocomplete = (query: Record<string, string>, session: Session | null = user) =>
    call<Suggestion[]>(test, 'autocompletePlaces', {
      query,
      ...(session ? { token: session.accessToken } : {}),
    });

  beforeAll(async () => {
    test = await createTestApp();
    user = await registerUser(test);
  });
  afterAll(() => test?.close());

  describe('GET /places/autocomplete', () => {
    it('devuelve sugerencias para lo que se escribe', async () => {
      const { status, body } = await autocomplete({ q: 'carolina' });

      expect(status).toBe(200);
      expect(body[0]).toMatchObject({
        label: 'Parque La Carolina',
        secondaryLabel: 'Iñaquito, Quito',
      });
      expect(body.length).toBeLessThanOrEqual(5);
    });

    it('pasa el sesgo de ubicacion al geocoder', async () => {
      const nearCumbaya = await autocomplete({ q: 'parque', lat: '-0.2003', lng: '-78.4313' });
      const nearCenter = await autocomplete({ q: 'parque', lat: '-0.2201', lng: '-78.5123' });

      expect(nearCumbaya.body[0]?.label).toBe('Parque de Cumbayá');
      expect(nearCenter.body[0]?.label).not.toBe('Parque de Cumbayá');
    });

    it('sin coincidencias devuelve una lista vacia', async () => {
      expect((await autocomplete({ q: 'zzzz no existe' })).body).toEqual([]);
    });

    it('exige sesion: no hay busqueda de lugares abierta al publico', async () => {
      expect((await autocomplete({ q: 'carolina' }, null)).status).toBe(401);
    });

    it.each([
      ['sin q', {}],
      ['con q de un caracter', { q: 'a' }],
      ['con latitud fuera de rango', { q: 'parque', lat: '95', lng: '-78.5' }],
      ['con latitud sin longitud', { q: 'parque', lat: '-0.2' }],
      ['con longitud sin latitud', { q: 'parque', lng: '-78.5' }],
    ])('%s es 422', async (_name, query) => {
      const { status, body } = await autocomplete(query as Record<string, string>);
      expect(status).toBe(422);
      expect(body).toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('si el geocoder no responde es 503 GEOCODING_PROVIDER_UNAVAILABLE', async () => {
      test.geocoding.failNext('GEOCODING_PROVIDER_UNAVAILABLE');
      const { status, body } = await autocomplete({ q: 'carolina' });

      expect(status).toBe(503);
      expect(body).toMatchObject({ code: 'GEOCODING_PROVIDER_UNAVAILABLE' });
    });

    it('la peticion 61 en un minuto es 429', async () => {
      const session = await registerUser(test);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        expect((await autocomplete({ q: 'parque' }, session)).status).toBe(200);
      }
      const blocked = await autocomplete({ q: 'parque' }, session);
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    });
  });

  describe('GET /places/{placeId}', () => {
    it('resuelve una sugerencia a etiqueta y coordenadas', async () => {
      const [first] = (await autocomplete({ q: 'plaza grande' })).body;

      const { status, body } = await call(test, 'resolvePlace', {
        token: user.accessToken,
        params: { placeId: first!.id },
      });

      expect(status).toBe(200);
      expect(body).toMatchObject({
        id: first!.id,
        label: 'Plaza Grande',
        lat: -0.2201,
        lng: -78.5123,
      });
    });

    it('un id que no emitio la API es 404 PLACE_NOT_FOUND', async () => {
      const { status, body } = await call(test, 'resolvePlace', {
        token: user.accessToken,
        params: { placeId: 'W31133611' },
      });
      expect(status).toBe(404);
      expect(body).toMatchObject({ code: 'PLACE_NOT_FOUND' });
    });

    it('exige sesion', async () => {
      expect((await call(test, 'resolvePlace', { params: { placeId: 'x' } })).status).toBe(401);
    });
  });
});
