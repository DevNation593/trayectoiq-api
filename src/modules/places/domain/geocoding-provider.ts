import type { LatLng } from '../../../shared/geo/geo.js';
import type { ProviderHealth } from '../../../shared/providers/provider-health.js';

/** Misma forma que PlaceSuggestion en openapi.yaml. */
export interface PlaceSuggestion {
  id: string;
  label: string;
  secondaryLabel?: string;
}

/** Misma forma que ResolvedPlace en openapi.yaml. */
export interface ResolvedPlace {
  id: string;
  label: string;
  lat: number;
  lng: number;
}

export type GeocodingErrorCode = 'PLACE_NOT_FOUND' | 'GEOCODING_PROVIDER_UNAVAILABLE';

export class GeocodingError extends Error {
  constructor(
    readonly code: GeocodingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GeocodingError';
  }
}

export interface GeocodingProvider {
  /** Hasta 5 sugerencias dentro del area de servicio, las mas relevantes primero. */
  autocomplete(query: string, bias?: LatLng): Promise<PlaceSuggestion[]>;
  resolve(placeId: string): Promise<ResolvedPlace>;
  health(): Promise<ProviderHealth>;
}

export const MAX_SUGGESTIONS = 5;
