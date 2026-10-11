import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GeocodingError } from '../../src/modules/places/domain/geocoding-provider.js';
import { PhotonGeocodingProvider } from '../../src/modules/places/providers/photon-geocoding.provider.js';
import { QUITO_SERVICE_AREA } from '../../src/shared/geo/geo.js';
import { recording, StubServer } from '../support/stub-server.js';

/**
 * El adaptador se prueba con su cliente HTTP real contra respuestas grabadas de un Photon
 * con el indice de Ecuador (test/fixtures/photon). CI no sale a la red.
 */

interface Feature {
  geometry: { coordinates: number[] };
  properties: Record<string, unknown>;
}
const featuresOf = (reply: { body: unknown }): Feature[] =>
  (reply.body as { features: Feature[] }).features;

describe('PhotonGeocodingProvider', () => {
  const stub = new StubServer();
  let provider: PhotonGeocodingProvider;

  const codeOf = async (work: Promise<unknown>): Promise<string> => {
    try {
      await work;
    } catch (error) {
      if (error instanceof GeocodingError) return error.code;
      throw error;
    }
    return 'NO_ERROR';
  };

  beforeAll(async () => {
    provider = new PhotonGeocodingProvider({
      baseUrl: await stub.start(),
      serviceArea: QUITO_SERVICE_AREA,
      timeoutMs: 150,
    });
  });
  beforeEach(() => stub.reset());
  afterAll(() => stub.stop());

  describe('autocomplete', () => {
    it('devuelve el lugar conocido primero, con barrio y ciudad como etiqueta secundaria', async () => {
      stub.reply(recording('photon', 'carolina'));

      const suggestions = await provider.autocomplete('parque la carolina');

      expect(suggestions[0]).toMatchObject({
        label: 'Parque La Carolina',
        secondaryLabel: 'Avenida de los Shyris, La Carolina, Quito',
      });
      expect(suggestions.length).toBeLessThanOrEqual(5);
    });

    it('cada sugerencia se resuelve a las coordenadas que dio Photon, sin otra consulta', async () => {
      stub.reply(recording('photon', 'carolina'));
      const [first] = await provider.autocomplete('parque la carolina');
      stub.reset();

      const resolved = await provider.resolve(first!.id);

      expect(resolved).toEqual({
        id: first!.id,
        label: 'Parque La Carolina, Avenida de los Shyris, La Carolina, Quito',
        lat: -0.183873,
        lng: -78.484703,
      });
      expect(stub.requests).toHaveLength(0);
    });

    it('consulta /api acotando al area de servicio y sesgando hacia el punto dado', async () => {
      stub.reply(recording('photon', 'carolina'));

      await provider.autocomplete('  parque la carolina ', { lat: -0.2003, lng: -78.4313 });

      expect(stub.requests[0]).toMatchObject({
        method: 'GET',
        path: '/api',
        query: {
          q: 'parque la carolina',
          bbox: '-78.65,-0.45,-78.25,0.08',
          lat: '-0.2003',
          lon: '-78.4313',
          limit: '15',
        },
      });
    });

    it('sin sesgo usa el centro del area de servicio', async () => {
      stub.reply(recording('photon', 'carolina'));

      await provider.autocomplete('parque');

      const { lat, lon } = stub.requests[0]!.query;
      expect(Number(lat)).toBeCloseTo(-0.185, 6);
      expect(Number(lon)).toBeCloseTo(-78.45, 6);
    });

    it('colapsa resultados repetidos: mismo nombre y misma zona aparecen una vez', async () => {
      stub.reply(recording('photon', 'partial')); // "Quicentro Sur" llega 4 veces

      const labels = (await provider.autocomplete('quicen')).map(
        (suggestion) => `${suggestion.label} | ${suggestion.secondaryLabel}`,
      );

      expect(labels).toEqual([
        'Quicentro Sur | Avenida Morán Valverde, Unión Popular, Quito',
        'Quicentro Sur | Avenida Morán Valverde, Quitumbe, Quito',
        'Quicentro | El Comercio, Iñaquito, Quito',
      ]);
    });

    it('una calle se muestra con su barrio para distinguir tramos', async () => {
      stub.reply(recording('photon', 'street'));

      const suggestions = await provider.autocomplete('avenida amazonas');

      expect(suggestions.map((suggestion) => suggestion.secondaryLabel)).toEqual([
        'La Florida, Quito',
        'El Carmen, Quito',
        'Mariscal Sucre, Quito',
      ]);
    });

    it('sin resultados devuelve una lista vacia', async () => {
      stub.reply(recording('photon', 'no-results'));

      expect(await provider.autocomplete('zzzzqqqq xxyyzz')).toEqual([]);
    });

    it('con menos de 2 caracteres no consulta al proveedor', async () => {
      expect(await provider.autocomplete(' a ')).toEqual([]);
      expect(await provider.autocomplete('')).toEqual([]);
      expect(stub.requests).toHaveLength(0);
    });

    it('recorta consultas largas a 120 caracteres', async () => {
      stub.reply(recording('photon', 'no-results'));

      await provider.autocomplete('x'.repeat(500));

      expect(stub.requests[0]?.query.q).toHaveLength(120);
    });

    it('descarta resultados fuera del area de servicio aunque Photon los devuelva', async () => {
      const reply = recording('photon', 'carolina');
      featuresOf(reply)[0]!.geometry.coordinates = [-79.8891, -2.1894]; // Guayaquil
      stub.reply(reply);

      const suggestions = await provider.autocomplete('parque la carolina');

      expect(suggestions.map((suggestion) => suggestion.label)).not.toContain('Parque La Carolina');
    });

    it('un resultado sin nombre usa calle y numero; sin nada que mostrar se descarta', async () => {
      const reply = recording('photon', 'carolina');
      const features = featuresOf(reply);
      features[0]!.properties = {
        street: 'Avenida 6 de Diciembre',
        housenumber: 'N34-120',
        city: 'Quito',
      };
      features[1]!.properties = { city: 'Quito' };
      stub.reply(reply);

      const suggestions = await provider.autocomplete('6 de diciembre');

      expect(suggestions[0]).toMatchObject({
        label: 'Avenida 6 de Diciembre N34-120',
        secondaryLabel: 'Quito',
      });
      expect(suggestions.every((suggestion) => suggestion.label.trim() !== '')).toBe(true);
    });

    it('nunca devuelve mas de 5 sugerencias', async () => {
      const reply = recording('photon', 'carolina');
      const [template] = featuresOf(reply);
      (reply.body as { features: Feature[] }).features = Array.from({ length: 12 }, (_, index) => ({
        ...template!,
        properties: { ...template!.properties, name: `Lugar ${index}` },
      }));
      stub.reply(reply);

      expect(await provider.autocomplete('lugar')).toHaveLength(5);
    });
  });

  describe('proveedor no disponible', () => {
    it('dos 5xx seguidos son GEOCODING_PROVIDER_UNAVAILABLE, con un reintento', async () => {
      stub.reply({ status: 500, body: {} });

      expect(await codeOf(provider.autocomplete('parque'))).toBe('GEOCODING_PROVIDER_UNAVAILABLE');
      expect(stub.requests).toHaveLength(2);
    });

    it('un 400 de Photon es GEOCODING_PROVIDER_UNAVAILABLE', async () => {
      stub.reply(recording('photon', 'bad-request'));

      expect(await codeOf(provider.autocomplete('parque'))).toBe('GEOCODING_PROVIDER_UNAVAILABLE');
    });

    it.each([
      ['sin features', {}],
      ['con features que no es una lista', { features: 'x' }],
    ])('una respuesta 200 %s es GEOCODING_PROVIDER_UNAVAILABLE', async (_name, body) => {
      stub.reply({ status: 200, body });

      expect(await codeOf(provider.autocomplete('parque'))).toBe('GEOCODING_PROVIDER_UNAVAILABLE');
    });

    it('una feature mal formada se omite sin tumbar el resto', async () => {
      const reply = recording('photon', 'carolina');
      (featuresOf(reply) as unknown[])[0] = { geometry: null, properties: null };
      stub.reply(reply);

      const suggestions = await provider.autocomplete('parque la carolina');

      expect(suggestions.length).toBeGreaterThan(0);
    });
  });

  describe('resolve', () => {
    it('un id que no emitio este servicio es PLACE_NOT_FOUND', async () => {
      expect(await codeOf(provider.resolve('W31133611'))).toBe('PLACE_NOT_FOUND');
    });
  });

  describe('salud', () => {
    it('up con la fecha de importacion cuando /status responde', async () => {
      stub.reply({ status: 200, body: JSON.parse(recording('photon', 'status').body as string) });

      const health = await provider.health();

      expect(health).toMatchObject({ provider: 'photon', status: 'up' });
      expect(health.detail).toContain('2026-10-03');
    });

    it('down, sin lanzar, cuando /status falla', async () => {
      stub.reply({ status: 503, body: {} });

      expect(await provider.health()).toMatchObject({ provider: 'photon', status: 'down' });
    });
  });
});
