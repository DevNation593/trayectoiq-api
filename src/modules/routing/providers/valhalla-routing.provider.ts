import type { LatLng } from '../../../shared/geo/geo.js';
import { requestJson, UpstreamError } from '../../../shared/http/upstream.js';
import type { ProviderHealth } from '../../../shared/providers/provider-health.js';
import {
  type RouteInput,
  type RouteResult,
  RoutingError,
  type RoutingProfile,
  type RoutingProvider,
} from '../domain/routing-provider.js';

export interface ValhallaOptions {
  baseUrl: string;
  /** Limite por intento. 04_ARCHITECTURE.md seccion 4: 2.5 s. */
  timeoutMs?: number;
  /** Reintentos ante timeout, error de red o 5xx. 04_ARCHITECTURE.md seccion 4: uno. */
  retries?: number;
}

const COSTING: Record<RoutingProfile, string> = { MOTORCYCLE: 'motorcycle', CAR: 'auto' };

/**
 * Codigos de error de Valhalla que significan "no hay ruta entre esos puntos" y no una falla
 * del servicio: 15x (la ruta excede un limite), 17x (punto sin vias cercanas o regiones sin
 * conexion) y 44x (no se encontro camino).
 */
const isNoRouteCode = (code: unknown): boolean =>
  typeof code === 'number' &&
  ((code >= 150 && code <= 159) || (code >= 170 && code <= 179) || (code >= 440 && code <= 449));

interface Leg {
  meters: number;
  seconds: number;
}

/** Lee los tramos de una respuesta de /route. Devuelve null si no tiene la forma esperada. */
function readLegs(body: unknown, expected: number): Leg[] | null {
  const legs = (body as { trip?: { legs?: unknown } } | null)?.trip?.legs;
  if (!Array.isArray(legs) || legs.length !== expected) {
    return null;
  }
  const result: Leg[] = [];
  for (const leg of legs) {
    const summary = (leg as { summary?: { length?: unknown; time?: unknown } } | null)?.summary;
    const km = summary?.length;
    const seconds = summary?.time;
    if (
      typeof km !== 'number' ||
      typeof seconds !== 'number' ||
      !Number.isFinite(km) ||
      !Number.isFinite(seconds) ||
      km < 0 ||
      seconds < 0
    ) {
      return null;
    }
    result.push({ meters: Math.round(km * 1000), seconds: Math.round(seconds) });
  }
  return result;
}

/** Adaptador de Valhalla (ADR-005). No aplica el area de servicio: eso lo hace ServiceAreaRoutingProvider. */
export class ValhallaRoutingProvider implements RoutingProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(options: ValhallaOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 2500;
    this.retries = options.retries ?? 1;
  }

  async route(input: RouteInput): Promise<RouteResult> {
    // Una sola llamada: con origen, el pickup es un punto intermedio y Valhalla devuelve un tramo por par.
    const points: LatLng[] = [
      ...(input.origin ? [input.origin] : []),
      input.pickup,
      input.destination,
    ];
    const costing = COSTING[input.profile];

    let response;
    try {
      response = await requestJson(
        `${this.baseUrl}/route`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            locations: points.map((point) => ({ lat: point.lat, lon: point.lng })),
            costing,
            units: 'kilometers',
            directions_type: 'none',
          }),
        },
        { timeoutMs: this.timeoutMs, retries: this.retries },
      );
    } catch (error) {
      if (error instanceof UpstreamError) {
        throw new RoutingError('ROUTING_PROVIDER_UNAVAILABLE', `Valhalla: ${error.message}`);
      }
      throw error;
    }

    if (response.status !== 200) {
      const errorCode = (response.body as { error_code?: unknown } | null)?.error_code;
      if (response.status === 400 && isNoRouteCode(errorCode)) {
        throw new RoutingError('ROUTE_UNAVAILABLE', 'No hay ruta entre esos puntos');
      }
      // Cualquier otro 4xx es una peticion que este adaptador armo mal: no es culpa del usuario.
      throw new RoutingError(
        'ROUTING_PROVIDER_UNAVAILABLE',
        `Valhalla respondio ${response.status} (error_code ${String(errorCode)})`,
      );
    }

    const legs = readLegs(response.body, points.length - 1);
    const trip = legs?.at(-1);
    if (!legs || !trip) {
      throw new RoutingError('ROUTING_PROVIDER_UNAVAILABLE', 'Valhalla devolvio una ruta ilegible');
    }
    if (trip.meters === 0 || trip.seconds === 0) {
      throw new RoutingError('ROUTE_UNAVAILABLE', 'El pickup y el destino son el mismo punto');
    }
    const pickup: Leg = input.origin && legs[0] ? legs[0] : { meters: 0, seconds: 0 };

    return {
      provider: 'valhalla',
      routingProfile: costing,
      pickupDistanceMeters: pickup.meters,
      pickupDurationSeconds: pickup.seconds,
      tripDistanceMeters: trip.meters,
      tripDurationSeconds: trip.seconds,
    };
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
          provider: 'valhalla',
          status: 'down',
          latencyMs: elapsed(),
          detail: `HTTP ${status}`,
        };
      }
      const version = (body as { version?: unknown } | null)?.version;
      return {
        provider: 'valhalla',
        status: 'up',
        latencyMs: elapsed(),
        detail: typeof version === 'string' ? `version ${version}` : undefined,
      };
    } catch (error) {
      return {
        provider: 'valhalla',
        status: 'down',
        latencyMs: elapsed(),
        detail: (error as Error).message,
      };
    }
  }
}
