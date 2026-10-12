import { describe, expect, it } from 'vitest';
import {
  RoutingError,
  type RouteInput,
} from '../../src/modules/routing/domain/routing-provider.js';
import { FakeRoutingProvider } from '../../src/modules/routing/providers/fake-routing.provider.js';
import { ServiceAreaRoutingProvider } from '../../src/modules/routing/providers/service-area-routing.provider.js';
import { QUITO_SERVICE_AREA } from '../../src/shared/geo/geo.js';

const plazaGrande = { lat: -0.2201, lng: -78.5123 };
const carolina = { lat: -0.1807, lng: -78.4841 };
const cumbaya = { lat: -0.2003, lng: -78.4313 };
const guayaquil = { lat: -2.1894, lng: -79.8891 };

const moto = (extra: Partial<RouteInput> = {}): RouteInput => ({
  profile: 'MOTORCYCLE',
  pickup: plazaGrande,
  destination: carolina,
  ...extra,
});

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof RoutingError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

describe('FakeRoutingProvider', () => {
  it('es determinista: la misma entrada da la misma ruta', async () => {
    const provider = new FakeRoutingProvider();
    expect(await provider.route(moto())).toEqual(await provider.route(moto()));
  });

  it('devuelve metros y segundos enteros y positivos, e identifica proveedor y perfil', async () => {
    const result = await new FakeRoutingProvider().route(moto());
    expect(result.provider).toBe('fake');
    expect(result.routingProfile).toBe('motorcycle');
    expect(Number.isInteger(result.tripDistanceMeters)).toBe(true);
    expect(Number.isInteger(result.tripDurationSeconds)).toBe(true);
    expect(result.tripDistanceMeters).toBeGreaterThan(5_300);
    expect(result.tripDurationSeconds).toBeGreaterThan(0);
  });

  it('sin origen no hay tramo de recogida', async () => {
    const result = await new FakeRoutingProvider().route(moto());
    expect(result.pickupDistanceMeters).toBe(0);
    expect(result.pickupDurationSeconds).toBe(0);
  });

  it('con origen calcula el tramo de recogida sin alterar el trayecto', async () => {
    const provider = new FakeRoutingProvider();
    const without = await provider.route(moto());
    const withOrigin = await provider.route(moto({ origin: cumbaya }));
    expect(withOrigin.pickupDistanceMeters).toBeGreaterThan(0);
    expect(withOrigin.pickupDurationSeconds).toBeGreaterThan(0);
    expect(withOrigin.tripDistanceMeters).toBe(without.tripDistanceMeters);
    expect(withOrigin.tripDurationSeconds).toBe(without.tripDurationSeconds);
  });

  it('un destino mas lejano da una ruta mas larga', async () => {
    const provider = new FakeRoutingProvider();
    const near = await provider.route(moto());
    const far = await provider.route(moto({ destination: cumbaya }));
    expect(far.tripDistanceMeters).toBeGreaterThan(near.tripDistanceMeters);
  });

  it('el carro usa otro perfil y tarda distinto que la moto en la misma ruta', async () => {
    const provider = new FakeRoutingProvider();
    const motorcycle = await provider.route(moto());
    const car = await provider.route(moto({ profile: 'CAR' }));
    expect(car.routingProfile).toBe('auto');
    expect(car.tripDistanceMeters).toBe(motorcycle.tripDistanceMeters);
    expect(car.tripDurationSeconds).not.toBe(motorcycle.tripDurationSeconds);
  });

  it('pickup y destino iguales no tienen ruta', async () => {
    const provider = new FakeRoutingProvider();
    expect(await codeOf(provider.route(moto({ destination: plazaGrande })))).toBe(
      'ROUTE_UNAVAILABLE',
    );
  });

  it('registra cada llamada, para que los tests cuenten cuantas rutas se pidieron', async () => {
    const provider = new FakeRoutingProvider();
    await provider.route(moto());
    await provider.route(moto({ profile: 'CAR' }));
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.profile).toBe('CAR');
  });

  it('failNext hace fallar solo la siguiente llamada', async () => {
    const provider = new FakeRoutingProvider();
    provider.failNext('ROUTING_PROVIDER_UNAVAILABLE');
    expect(await codeOf(provider.route(moto()))).toBe('ROUTING_PROVIDER_UNAVAILABLE');
    expect(await codeOf(provider.route(moto()))).toBe('NO_ERROR');
    expect(provider.calls).toHaveLength(2);
  });

  it('respondWith fija la ruta de la siguiente llamada y solo de esa', async () => {
    const provider = new FakeRoutingProvider();
    const fixed = {
      provider: 'fake',
      routingProfile: 'motorcycle',
      pickupDistanceMeters: 2000,
      pickupDurationSeconds: 300,
      tripDistanceMeters: 12000,
      tripDurationSeconds: 1800,
    };
    provider.respondWith(fixed);

    expect(await provider.route(moto())).toEqual(fixed);
    expect((await provider.route(moto())).tripDistanceMeters).not.toBe(12000);
    expect(provider.calls).toHaveLength(2);
  });

  it('reporta salud', async () => {
    const health = await new FakeRoutingProvider().health();
    expect(health).toMatchObject({ provider: 'fake', status: 'up' });
  });
});

describe('ServiceAreaRoutingProvider', () => {
  const build = (): { inner: FakeRoutingProvider; provider: ServiceAreaRoutingProvider } => {
    const inner = new FakeRoutingProvider();
    return { inner, provider: new ServiceAreaRoutingProvider(inner, QUITO_SERVICE_AREA) };
  };

  it('delega cuando todos los puntos estan dentro del area', async () => {
    const { inner, provider } = build();
    const result = await provider.route(moto({ origin: cumbaya }));
    expect(result).toEqual(await new FakeRoutingProvider().route(moto({ origin: cumbaya })));
    expect(inner.calls).toHaveLength(1);
  });

  it.each([
    ['el destino', moto({ destination: guayaquil })],
    ['el pickup', moto({ pickup: guayaquil })],
    ['el origen', moto({ origin: guayaquil })],
  ])('rechaza cuando %s esta fuera del area, sin llamar al proveedor', async (_name, input) => {
    const { inner, provider } = build();
    expect(await codeOf(provider.route(input))).toBe('OUT_OF_SERVICE_AREA');
    expect(inner.calls).toHaveLength(0);
  });

  it('una coordenada invalida se trata como fuera del area', async () => {
    const { inner, provider } = build();
    const input = moto({ destination: { lat: Number.NaN, lng: -78.5 } });
    expect(await codeOf(provider.route(input))).toBe('OUT_OF_SERVICE_AREA');
    expect(inner.calls).toHaveLength(0);
  });

  it('propaga los errores y la salud del proveedor interno', async () => {
    const { inner, provider } = build();
    inner.failNext('ROUTE_UNAVAILABLE');
    expect(await codeOf(provider.route(moto()))).toBe('ROUTE_UNAVAILABLE');
    expect(await provider.health()).toMatchObject({ provider: 'fake', status: 'up' });
  });
});
