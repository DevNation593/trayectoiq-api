import type { LatLng } from '../../../shared/geo/geo.js';
import type { ProviderHealth } from '../../../shared/providers/provider-health.js';

export type RoutingProfile = 'MOTORCYCLE' | 'CAR';

export interface RouteInput {
  profile: RoutingProfile;
  /** Ubicacion actual del conductor. Si falta, ya esta en el punto de recogida (AT_PICKUP). */
  origin?: LatLng;
  pickup: LatLng;
  destination: LatLng;
}

/**
 * Ruta normalizada: el dominio no conoce al proveedor. Metros y segundos enteros por tramo,
 * tal como los espera el Pricing Engine (03_PRICING_ENGINE.md seccion 3).
 */
export interface RouteResult {
  provider: string;
  /** Perfil tal como lo nombra el proveedor; se guarda en quotes.routing_profile. */
  routingProfile: string;
  pickupDistanceMeters: number;
  pickupDurationSeconds: number;
  tripDistanceMeters: number;
  tripDurationSeconds: number;
}

/** Codigos del catalogo de openapi.yaml. */
export type RoutingErrorCode =
  'ROUTE_UNAVAILABLE' | 'OUT_OF_SERVICE_AREA' | 'ROUTING_PROVIDER_UNAVAILABLE';

export class RoutingError extends Error {
  constructor(
    readonly code: RoutingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RoutingError';
  }
}

export interface RoutingProvider {
  /** Lanza RoutingError. Nunca devuelve una ruta con trayecto de cero metros o cero segundos. */
  route(input: RouteInput): Promise<RouteResult>;
  health(): Promise<ProviderHealth>;
}
