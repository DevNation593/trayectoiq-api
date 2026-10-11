import type { LatLng, ServiceArea } from '../../../shared/geo/geo.js';
import { requestJson, UpstreamError } from '../../../shared/http/upstream.js';
import type { ProviderHealth } from '../../../shared/providers/provider-health.js';
import {
  GeocodingError,
  type GeocodingProvider,
  MAX_SUGGESTIONS,
  type PlaceSuggestion,
  type ResolvedPlace,
} from '../domain/geocoding-provider.js';
import { decodePlaceId, encodePlaceId } from '../domain/place-id.js';

export interface PhotonOptions {
  baseUrl: string;
  /** Las sugerencias se acotan a esta caja y, sin otro sesgo, se ordenan hacia su centro. */
  serviceArea: ServiceArea;
  timeoutMs?: number;
  retries?: number;
}

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 120;
/** Se piden mas resultados de los que se muestran porque Photon repite un mismo lugar varias veces. */
const FETCH_LIMIT = 15;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

interface Candidate {
  label: string;
  secondaryLabel?: string;
  lat: number;
  lng: number;
}

/** Convierte una feature GeoJSON de Photon en una sugerencia. Devuelve null si no sirve para mostrar. */
function toCandidate(feature: unknown): Candidate | null {
  const { geometry, properties } = (feature ?? {}) as {
    geometry?: { coordinates?: unknown } | null;
    properties?: Record<string, unknown> | null;
  };
  const coordinates = geometry?.coordinates;
  if (!Array.isArray(coordinates) || !properties) {
    return null;
  }
  const [lng, lat] = coordinates as unknown[];
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return null;
  }

  const name = text(properties.name);
  const street = text(properties.street);
  const houseNumber = text(properties.housenumber);
  const address = street ? [street, houseNumber].filter(Boolean).join(' ') : undefined;
  const label = name ?? address;
  if (!label) {
    return null;
  }

  // Con nombre propio, la calle ayuda a ubicarlo; sin nombre, la calle ya es la etiqueta.
  const context = [name ? street : undefined, text(properties.district), text(properties.city)];
  const secondary = [...new Set(context.filter((part) => part && part !== label))].join(', ');
  return { label, secondaryLabel: secondary === '' ? undefined : secondary, lat, lng };
}

/** Adaptador de Photon (ADR-005): autocompletado sobre OpenStreetMap acotado al area de servicio. */
export class PhotonGeocodingProvider implements GeocodingProvider {
  private readonly baseUrl: string;
  private readonly area: ServiceArea;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(options: PhotonOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.area = options.serviceArea;
    this.timeoutMs = options.timeoutMs ?? 2000;
    this.retries = options.retries ?? 1;
  }

  async autocomplete(query: string, bias?: LatLng): Promise<PlaceSuggestion[]> {
    const q = query.trim().slice(0, MAX_QUERY_LENGTH);
    if (q.length < MIN_QUERY_LENGTH) {
      return [];
    }
    const center = bias ?? this.area.center();
    const params = new URLSearchParams({
      q,
      limit: String(FETCH_LIMIT),
      bbox: this.area.toBbox(),
      lat: String(center.lat),
      lon: String(center.lng),
    });

    let response;
    try {
      response = await requestJson(
        `${this.baseUrl}/api?${params.toString()}`,
        { method: 'GET' },
        { timeoutMs: this.timeoutMs, retries: this.retries },
      );
    } catch (error) {
      if (error instanceof UpstreamError) {
        throw new GeocodingError('GEOCODING_PROVIDER_UNAVAILABLE', `Photon: ${error.message}`);
      }
      throw error;
    }

    const features = (response.body as { features?: unknown } | null)?.features;
    if (response.status !== 200 || !Array.isArray(features)) {
      throw new GeocodingError(
        'GEOCODING_PROVIDER_UNAVAILABLE',
        `Photon respondio ${response.status} con un cuerpo inesperado`,
      );
    }

    const seen = new Set<string>();
    const suggestions: PlaceSuggestion[] = [];
    for (const feature of features) {
      const candidate = toCandidate(feature);
      if (!candidate || !this.area.contains(candidate)) continue;

      const key = `${candidate.label}|${candidate.secondaryLabel ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const fullLabel = [candidate.label, candidate.secondaryLabel].filter(Boolean).join(', ');
      suggestions.push({
        id: encodePlaceId({ label: fullLabel, lat: candidate.lat, lng: candidate.lng }),
        label: candidate.label,
        ...(candidate.secondaryLabel ? { secondaryLabel: candidate.secondaryLabel } : {}),
      });
      if (suggestions.length === MAX_SUGGESTIONS) break;
    }
    return suggestions;
  }

  /** Photon no busca por id: el placeId ya contiene etiqueta y coordenadas. */
  resolve(placeId: string): Promise<ResolvedPlace> {
    try {
      return Promise.resolve(decodePlaceId(placeId));
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }

  async health(): Promise<ProviderHealth> {
    const started = performance.now();
    const elapsed = (): number => Math.round(performance.now() - started);
    try {
      const { status, body } = await requestJson(
        `${this.baseUrl}/status`,
        { method: 'GET' },
        { timeoutMs: this.timeoutMs, retries: 0 },
      );
      if (status !== 200) {
        return {
          provider: 'photon',
          status: 'down',
          latencyMs: elapsed(),
          detail: `HTTP ${status}`,
        };
      }
      const importDate = (body as { import_date?: unknown } | null)?.import_date;
      return {
        provider: 'photon',
        status: 'up',
        latencyMs: elapsed(),
        detail: typeof importDate === 'string' ? `datos del ${importDate}` : undefined,
      };
    } catch (error) {
      return {
        provider: 'photon',
        status: 'down',
        latencyMs: elapsed(),
        detail: (error as Error).message,
      };
    }
  }
}
