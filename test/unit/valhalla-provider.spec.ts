import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  RoutingError,
  type RouteInput,
} from '../../src/modules/routing/domain/routing-provider.js';
import { ValhallaRoutingProvider } from '../../src/modules/routing/providers/valhalla-routing.provider.js';
import { recording, StubServer } from '../support/stub-server.js';

/**
 * El adaptador se prueba con su cliente HTTP real contra respuestas grabadas de un Valhalla
 * con el extracto de Ecuador (test/fixtures/valhalla). CI no sale a la red.
 */

const plazaGrande = { lat: -0.2201, lng: -78.5123 };
const carolina = { lat: -0.1807, lng: -78.4841 };
const cumbaya = { lat: -0.2003, lng: -78.4313 };

const input = (extra: Partial<RouteInput> = {}): RouteInput => ({
  profile: 'MOTORCYCLE',
  pickup: plazaGrande,
  destination: carolina,
  ...extra,
});

describe('ValhallaRoutingProvider', () => {
  const stub = new StubServer();
  let baseUrl: string;
  let provider: ValhallaRoutingProvider;

  const codeOf = async (work: Promise<unknown>): Promise<string> => {
    try {
      await work;
    } catch (error) {
      if (error instanceof RoutingError) return error.code;
      throw error;
    }
    return 'NO_ERROR';
  };

  beforeAll(async () => {
    baseUrl = await stub.start();
    provider = new ValhallaRoutingProvider({ baseUrl, timeoutMs: 150 });
  });
  beforeEach(() => stub.reset());
  afterAll(() => stub.stop());

  describe('ruta encontrada', () => {
    it('convierte km y segundos decimales en metros y segundos enteros', async () => {
      stub.reply(recording('valhalla', 'route-motorcycle')); // 7.121 km, 1273.098 s

      expect(await provider.route(input())).toEqual({
        provider: 'valhalla',
        routingProfile: 'motorcycle',
        pickupDistanceMeters: 0,
        pickupDurationSeconds: 0,
        tripDistanceMeters: 7121,
        tripDurationSeconds: 1273,
      });
    });

    it('pide la ruta a /route con el perfil y los puntos en orden', async () => {
      stub.reply(recording('valhalla', 'route-motorcycle'));

      await provider.route(input());

      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]).toMatchObject({
        method: 'POST',
        path: '/route',
        body: {
          costing: 'motorcycle',
          units: 'kilometers',
          directions_type: 'none',
          locations: [
            { lat: -0.2201, lon: -78.5123 },
            { lat: -0.1807, lon: -78.4841 },
          ],
        },
      });
    });

    it('el carro usa el perfil auto', async () => {
      stub.reply(recording('valhalla', 'route-auto'));

      const result = await provider.route(input({ profile: 'CAR' }));

      expect(result.routingProfile).toBe('auto');
      expect(stub.requests[0]?.body).toMatchObject({ costing: 'auto' });
    });

    it('con origen hace una sola llamada con tres puntos y separa recogida y trayecto', async () => {
      stub.reply(recording('valhalla', 'route-with-pickup')); // 12.27 km/2007.915 s + 7.121 km/1273.098 s

      const result = await provider.route(input({ origin: cumbaya }));

      expect(result).toMatchObject({
        pickupDistanceMeters: 12270,
        pickupDurationSeconds: 2008,
        tripDistanceMeters: 7121,
        tripDurationSeconds: 1273,
      });
      expect(stub.requests).toHaveLength(1);
      expect((stub.requests[0]?.body as { locations: unknown[] }).locations).toEqual([
        { lat: -0.2003, lon: -78.4313 },
        { lat: -0.2201, lon: -78.5123 },
        { lat: -0.1807, lon: -78.4841 },
      ]);
    });

    it('un origen pegado al pickup da recogida cero y sigue siendo valido', async () => {
      const reply = recording('valhalla', 'route-with-pickup');
      const legs = (reply.body as { trip: { legs: { summary: Record<string, number> }[] } }).trip
        .legs;
      legs[0]!.summary.length = 0;
      legs[0]!.summary.time = 0;
      stub.reply(reply);

      const result = await provider.route(input({ origin: plazaGrande }));

      expect(result.pickupDistanceMeters).toBe(0);
      expect(result.tripDistanceMeters).toBe(7121);
    });
  });

  describe('sin ruta', () => {
    it.each(['no-path-island', 'no-edges-ocean'])(
      '%s es ROUTE_UNAVAILABLE y no se reintenta',
      async (name) => {
        stub.reply(recording('valhalla', name));

        expect(await codeOf(provider.route(input()))).toBe('ROUTE_UNAVAILABLE');
        expect(stub.requests).toHaveLength(1);
      },
    );

    it('codigo 442 (no se encontro camino) es ROUTE_UNAVAILABLE', async () => {
      stub.reply({ status: 400, body: { error_code: 442, error: 'No path could be found' } });
      expect(await codeOf(provider.route(input()))).toBe('ROUTE_UNAVAILABLE');
    });

    it('un trayecto que redondea a cero metros es ROUTE_UNAVAILABLE', async () => {
      const reply = recording('valhalla', 'route-motorcycle');
      const summary = (reply.body as { trip: { legs: { summary: Record<string, number> }[] } }).trip
        .legs[0]!.summary;
      summary.length = 0.0003;
      summary.time = 0.2;
      stub.reply(reply);

      expect(await codeOf(provider.route(input()))).toBe('ROUTE_UNAVAILABLE');
    });
  });

  describe('proveedor no disponible', () => {
    it('reintenta una vez tras un 5xx y devuelve la ruta', async () => {
      stub.reply({ status: 503, body: {} }, recording('valhalla', 'route-motorcycle'));

      expect((await provider.route(input())).tripDistanceMeters).toBe(7121);
      expect(stub.requests).toHaveLength(2);
    });

    it('dos 5xx seguidos son ROUTING_PROVIDER_UNAVAILABLE', async () => {
      stub.reply({ status: 500, body: {} });

      expect(await codeOf(provider.route(input()))).toBe('ROUTING_PROVIDER_UNAVAILABLE');
      expect(stub.requests).toHaveLength(2);
    });

    it('un timeout en ambos intentos es ROUTING_PROVIDER_UNAVAILABLE', async () => {
      stub.reply({ ...recording('valhalla', 'route-motorcycle'), delayMs: 600 });

      expect(await codeOf(provider.route(input()))).toBe('ROUTING_PROVIDER_UNAVAILABLE');
    });

    it('un 400 que no habla de la ruta (peticion mal armada) no se le atribuye al usuario', async () => {
      stub.reply({ status: 400, body: { error_code: 100, error: 'Failed to parse json request' } });

      expect(await codeOf(provider.route(input()))).toBe('ROUTING_PROVIDER_UNAVAILABLE');
    });

    it.each([
      ['sin trip', {}],
      ['sin legs', { trip: {} }],
      ['con menos tramos de los pedidos', { trip: { legs: [] } }],
      ['con un tramo sin resumen', { trip: { legs: [{}] } }],
      ['con distancia no numerica', { trip: { legs: [{ summary: { length: 'x', time: 10 } }] } }],
      ['con tiempo negativo', { trip: { legs: [{ summary: { length: 1, time: -5 } }] } }],
    ])('una respuesta 200 %s es ROUTING_PROVIDER_UNAVAILABLE', async (_name, body) => {
      stub.reply({ status: 200, body });

      expect(await codeOf(provider.route(input()))).toBe('ROUTING_PROVIDER_UNAVAILABLE');
    });

    it('si Valhalla no esta levantado es ROUTING_PROVIDER_UNAVAILABLE', async () => {
      const closed = new StubServer();
      const baseUrl = await closed.start();
      await closed.stop();
      const offline = new ValhallaRoutingProvider({ baseUrl, timeoutMs: 150 });

      expect(await codeOf(offline.route(input()))).toBe('ROUTING_PROVIDER_UNAVAILABLE');
    });
  });

  describe('salud', () => {
    it('up con la version cuando /status responde', async () => {
      stub.reply(recording('valhalla', 'status'));

      const health = await provider.health();

      expect(health).toMatchObject({ provider: 'valhalla', status: 'up' });
      expect(health.detail).toContain('3.9.1');
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      expect(stub.requests[0]).toMatchObject({ method: 'GET', path: '/status' });
    });

    it('down, sin lanzar, cuando /status falla', async () => {
      stub.reply({ status: 500, body: {} });

      expect(await provider.health()).toMatchObject({ provider: 'valhalla', status: 'down' });
    });
  });

  it('acepta una URL base con barra final', async () => {
    const trailing = new ValhallaRoutingProvider({ baseUrl: `${baseUrl}/`, timeoutMs: 150 });
    stub.reply(recording('valhalla', 'route-motorcycle'));

    await trailing.route(input());

    expect(stub.requests[0]?.path).toBe('/route');
  });
});
