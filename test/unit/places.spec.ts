import { describe, expect, it } from 'vitest';
import { GeocodingError } from '../../src/modules/places/domain/geocoding-provider.js';
import { decodePlaceId, encodePlaceId } from '../../src/modules/places/domain/place-id.js';
import { FakeGeocodingProvider } from '../../src/modules/places/providers/fake-geocoding.provider.js';

const codeOf = async (work: () => unknown): Promise<string> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof GeocodingError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

describe('placeId', () => {
  const place = { label: 'Parque La Carolina, Iñaquito', lat: -0.180653, lng: -78.484081 };

  it('es autocontenido: se decodifica sin consultar a ningun proveedor', () => {
    const id = encodePlaceId(place);
    expect(decodePlaceId(id)).toEqual({ id, ...place });
  });

  it('solo usa caracteres seguros para una ruta de URL', () => {
    expect(encodePlaceId(place)).toMatch(/^p1\.[A-Za-z0-9_-]+$/);
  });

  it('redondea las coordenadas a 6 decimales (~11 cm)', () => {
    const id = encodePlaceId({ label: 'X', lat: -0.18065349999, lng: -78.4840811111 });
    expect(decodePlaceId(id)).toMatchObject({ lat: -0.180653, lng: -78.484081 });
  });

  it('el mismo lugar da siempre el mismo id', () => {
    expect(encodePlaceId(place)).toBe(encodePlaceId({ ...place }));
  });

  it.each([
    '',
    'p1.',
    'p1.%%%',
    'p2.eyJ4IjoxfQ',
    'no-es-un-id',
    `p1.${Buffer.from('"texto"').toString('base64url')}`,
    `p1.${Buffer.from('[1,2]').toString('base64url')}`,
    `p1.${Buffer.from('[95,0,"fuera de rango"]').toString('base64url')}`,
    `p1.${Buffer.from('["a","b","c"]').toString('base64url')}`,
    `p1.${Buffer.from('[0,0,""]').toString('base64url')}`,
  ])('un id mal formado (%j) es PLACE_NOT_FOUND', async (id) => {
    expect(await codeOf(() => decodePlaceId(id))).toBe('PLACE_NOT_FOUND');
  });

  it('rechaza codificar coordenadas invalidas o una etiqueta vacia', () => {
    expect(() => encodePlaceId({ label: 'X', lat: 95, lng: 0 })).toThrow();
    expect(() => encodePlaceId({ label: '  ', lat: 0, lng: 0 })).toThrow();
  });
});

describe('FakeGeocodingProvider', () => {
  const provider = new FakeGeocodingProvider();

  it('sugiere lugares por coincidencia parcial, sin distinguir mayusculas ni tildes', async () => {
    const suggestions = await provider.autocomplete('carolína');
    expect(suggestions[0]?.label).toBe('Parque La Carolina');
  });

  it('devuelve como maximo 5 sugerencias', async () => {
    expect((await provider.autocomplete('a')).length).toBeLessThanOrEqual(5);
  });

  it('sin coincidencias devuelve una lista vacia', async () => {
    expect(await provider.autocomplete('zzzz no existe')).toEqual([]);
  });

  it('es determinista', async () => {
    expect(await provider.autocomplete('parque')).toEqual(await provider.autocomplete('parque'));
  });

  it('con sesgo, ordena primero lo mas cercano', async () => {
    const nearCumbaya = await provider.autocomplete('parque', { lat: -0.2003, lng: -78.4313 });
    const nearCenter = await provider.autocomplete('parque', { lat: -0.2201, lng: -78.5123 });
    expect(nearCumbaya[0]?.label).not.toBe(nearCenter[0]?.label);
  });

  it('una sugerencia se resuelve a coordenadas', async () => {
    const [first] = await provider.autocomplete('plaza grande');
    const resolved = await provider.resolve(first!.id);
    expect(resolved).toMatchObject({ id: first!.id, label: 'Plaza Grande' });
    expect(resolved.lat).toBeCloseTo(-0.2201, 3);
    expect(resolved.lng).toBeCloseTo(-78.5123, 3);
  });

  it('resolver un id desconocido es PLACE_NOT_FOUND', async () => {
    expect(await codeOf(() => provider.resolve('inventado'))).toBe('PLACE_NOT_FOUND');
  });

  it('failNext hace fallar solo la siguiente llamada', async () => {
    const failing = new FakeGeocodingProvider();
    failing.failNext('GEOCODING_PROVIDER_UNAVAILABLE');
    expect(await codeOf(() => failing.autocomplete('parque'))).toBe(
      'GEOCODING_PROVIDER_UNAVAILABLE',
    );
    expect(await codeOf(() => failing.autocomplete('parque'))).toBe('NO_ERROR');
  });

  it('reporta salud', async () => {
    expect(await provider.health()).toMatchObject({ provider: 'fake', status: 'up' });
  });
});
