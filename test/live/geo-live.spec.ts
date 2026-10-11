import { describe, expect, it } from 'vitest';
import { PhotonGeocodingProvider } from '../../src/modules/places/providers/photon-geocoding.provider.js';
import { RoutingError } from '../../src/modules/routing/domain/routing-provider.js';
import { ServiceAreaRoutingProvider } from '../../src/modules/routing/providers/service-area-routing.provider.js';
import { ValhallaRoutingProvider } from '../../src/modules/routing/providers/valhalla-routing.provider.js';
import { haversineMeters, QUITO_SERVICE_AREA } from '../../src/shared/geo/geo.js';

/**
 * Pruebas contra Valhalla y Photon reales con datos de Ecuador:
 *
 *   docker compose --profile geo up -d
 *   pnpm test:live
 *
 * No corren en CI (necesitan los servicios y sus datos). Confirman lo que las grabaciones
 * no pueden: que los adaptadores siguen entendiendo a la version desplegada.
 */

const valhallaUrl = process.env.VALHALLA_URL ?? 'http://localhost:8002';
const photonUrl = process.env.PHOTON_URL ?? 'http://localhost:2322';

const plazaGrande = { lat: -0.2201, lng: -78.5123 };
const carolina = { lat: -0.1807, lng: -78.4841 };
const cumbaya = { lat: -0.2003, lng: -78.4313 };
const guayaquil = { lat: -2.1894, lng: -79.8891 };

describe('Valhalla real', () => {
  const valhalla = new ValhallaRoutingProvider({ baseUrl: valhallaUrl });
  const routing = new ServiceAreaRoutingProvider(valhalla, QUITO_SERVICE_AREA);

  it('esta levantado', async () => {
    expect(await valhalla.health()).toMatchObject({ provider: 'valhalla', status: 'up' });
  });

  it.each(['MOTORCYCLE', 'CAR'] as const)(
    'ruta en %s de la Plaza Grande a La Carolina con cifras plausibles',
    async (profile) => {
      const route = await routing.route({ profile, pickup: plazaGrande, destination: carolina });

      // En linea recta son ~5.4 km; por calle no puede ser menos ni un rodeo absurdo.
      expect(route.tripDistanceMeters).toBeGreaterThan(5_400);
      expect(route.tripDistanceMeters).toBeLessThan(15_000);
      expect(route.tripDurationSeconds).toBeGreaterThan(5 * 60);
      expect(route.tripDurationSeconds).toBeLessThan(60 * 60);
      expect(route.pickupDistanceMeters).toBe(0);
    },
  );

  it('con origen en Cumbaya devuelve el tramo de recogida en la misma llamada', async () => {
    const route = await routing.route({
      profile: 'CAR',
      origin: cumbaya,
      pickup: plazaGrande,
      destination: carolina,
    });

    expect(route.pickupDistanceMeters).toBeGreaterThan(8_000);
    expect(route.pickupDurationSeconds).toBeGreaterThan(0);
    expect(route.tripDistanceMeters).toBeGreaterThan(5_400);
  });

  it('un destino en Guayaquil queda fuera del area de servicio', async () => {
    const attempt = routing.route({
      profile: 'CAR',
      pickup: plazaGrande,
      destination: guayaquil,
    });

    await expect(attempt).rejects.toBeInstanceOf(RoutingError);
    await expect(attempt).rejects.toMatchObject({ code: 'OUT_OF_SERVICE_AREA' });
  });
});

describe('Photon real', () => {
  const photon = new PhotonGeocodingProvider({
    baseUrl: photonUrl,
    serviceArea: QUITO_SERVICE_AREA,
  });

  it('esta levantado', async () => {
    expect(await photon.health()).toMatchObject({ provider: 'photon', status: 'up' });
  });

  it('un lugar conocido aparece entre las 5 primeras sugerencias y se resuelve cerca', async () => {
    const suggestions = await photon.autocomplete('parque la carolina');
    const match = suggestions.find((suggestion) => suggestion.label === 'Parque La Carolina');

    expect(suggestions.length).toBeLessThanOrEqual(5);
    expect(match).toBeDefined();
    const place = await photon.resolve(match!.id);
    expect(haversineMeters(place, carolina)).toBeLessThan(1_000);
  });

  it('completa una palabra a medio escribir', async () => {
    const labels = (await photon.autocomplete('quicen')).map((suggestion) => suggestion.label);
    expect(labels.some((label) => label.startsWith('Quicentro'))).toBe(true);
  });

  it('todas las sugerencias caen dentro del area de servicio', async () => {
    for (const query of ['terminal', 'parque', 'avenida amazonas', 'malecon 2000 guayaquil']) {
      for (const suggestion of await photon.autocomplete(query)) {
        const place = await photon.resolve(suggestion.id);
        expect(QUITO_SERVICE_AREA.contains(place), `${query}: ${place.label}`).toBe(true);
      }
    }
  });
});
