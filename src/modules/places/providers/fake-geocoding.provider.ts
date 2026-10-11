import { haversineMeters, type LatLng } from '../../../shared/geo/geo.js';
import type { ProviderHealth } from '../../../shared/providers/provider-health.js';
import {
  GeocodingError,
  type GeocodingErrorCode,
  type GeocodingProvider,
  MAX_SUGGESTIONS,
  type PlaceSuggestion,
  type ResolvedPlace,
} from '../domain/geocoding-provider.js';
import { decodePlaceId, encodePlaceId } from '../domain/place-id.js';

const CATALOG: { label: string; secondaryLabel: string; lat: number; lng: number }[] = [
  { label: 'Plaza Grande', secondaryLabel: 'Centro Histórico, Quito', lat: -0.2201, lng: -78.5123 },
  { label: 'Parque La Carolina', secondaryLabel: 'Iñaquito, Quito', lat: -0.1807, lng: -78.4841 },
  { label: 'Parque El Ejido', secondaryLabel: 'La Mariscal, Quito', lat: -0.2085, lng: -78.4995 },
  { label: 'Parque Metropolitano', secondaryLabel: 'Bellavista, Quito', lat: -0.178, lng: -78.462 },
  { label: 'Parque de Cumbayá', secondaryLabel: 'Cumbayá, Quito', lat: -0.2003, lng: -78.4313 },
  { label: 'Terminal Quitumbe', secondaryLabel: 'Quitumbe, Quito', lat: -0.2975, lng: -78.5563 },
  { label: 'Terminal Carcelén', secondaryLabel: 'Carcelén, Quito', lat: -0.0935, lng: -78.4712 },
  { label: 'Aeropuerto Mariscal Sucre', secondaryLabel: 'Tababela', lat: -0.1292, lng: -78.3575 },
  { label: 'El Panecillo', secondaryLabel: 'Centro Histórico, Quito', lat: -0.2295, lng: -78.5188 },
  { label: 'San Luis Shopping', secondaryLabel: 'Los Chillos', lat: -0.3075, lng: -78.4507 },
];

/** Minusculas y sin tildes, para comparar como escribe la gente. */
const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

/** Geocoder determinista con un catalogo fijo de lugares de Quito, para tests y desarrollo. */
export class FakeGeocodingProvider implements GeocodingProvider {
  private pendingFailure: GeocodingErrorCode | null = null;

  /** La siguiente llamada falla con este codigo; las posteriores vuelven a funcionar. */
  failNext(code: GeocodingErrorCode): void {
    this.pendingFailure = code;
  }

  autocomplete(query: string, bias?: LatLng): Promise<PlaceSuggestion[]> {
    if (this.pendingFailure) {
      const code = this.pendingFailure;
      this.pendingFailure = null;
      return Promise.reject(new GeocodingError(code, `Fallo simulado: ${code}`));
    }
    const needle = normalize(query);
    const matches = CATALOG.filter(
      (place) =>
        needle !== '' && normalize(`${place.label} ${place.secondaryLabel}`).includes(needle),
    );
    if (bias) {
      matches.sort((a, b) => haversineMeters(bias, a) - haversineMeters(bias, b));
    }
    return Promise.resolve(
      matches.slice(0, MAX_SUGGESTIONS).map((place) => ({
        id: encodePlaceId(place),
        label: place.label,
        secondaryLabel: place.secondaryLabel,
      })),
    );
  }

  resolve(placeId: string): Promise<ResolvedPlace> {
    try {
      return Promise.resolve(decodePlaceId(placeId));
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }

  health(): Promise<ProviderHealth> {
    return Promise.resolve({ provider: 'fake', status: 'up', latencyMs: 0 });
  }
}
