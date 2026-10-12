import { haversineMeters, type LatLng } from '../../../shared/geo/geo.js';
import type { ProviderHealth } from '../../../shared/providers/provider-health.js';
import {
  type RouteInput,
  type RouteResult,
  RoutingError,
  type RoutingErrorCode,
  type RoutingProfile,
  type RoutingProvider,
} from '../domain/routing-provider.js';

/** Una calle rara vez es una linea recta: factor fijo sobre la distancia geodesica. */
const ROAD_FACTOR = 1.35;

const PROFILES: Record<RoutingProfile, { name: string; metersPerSecond: number }> = {
  MOTORCYCLE: { name: 'motorcycle', metersPerSecond: 30_000 / 3600 },
  CAR: { name: 'auto', metersPerSecond: 25_000 / 3600 },
};

/**
 * Proveedor determinista para tests y desarrollo sin Valhalla: la misma entrada da siempre
 * la misma ruta, calculada a partir de la distancia en linea recta. No estima nada real.
 */
export class FakeRoutingProvider implements RoutingProvider {
  /** Entradas recibidas, en orden: los tests cuentan cuantas rutas se pidieron. */
  readonly calls: RouteInput[] = [];
  private pendingFailure: RoutingErrorCode | null = null;
  private pendingResult: RouteResult | null = null;

  /** La siguiente llamada a route() falla con este codigo; las posteriores vuelven a funcionar. */
  failNext(code: RoutingErrorCode): void {
    this.pendingFailure = code;
  }

  /** La siguiente llamada a route() devuelve exactamente esta ruta; las posteriores vuelven a calcularse. */
  respondWith(result: RouteResult): void {
    this.pendingResult = result;
  }

  route(input: RouteInput): Promise<RouteResult> {
    this.calls.push(input);
    if (this.pendingFailure) {
      const code = this.pendingFailure;
      this.pendingFailure = null;
      return Promise.reject(new RoutingError(code, `Fallo simulado: ${code}`));
    }

    if (this.pendingResult) {
      const result = this.pendingResult;
      this.pendingResult = null;
      return Promise.resolve(result);
    }

    const profile = PROFILES[input.profile];
    const leg = (from: LatLng, to: LatLng): { meters: number; seconds: number } => {
      const meters = Math.round(haversineMeters(from, to) * ROAD_FACTOR);
      return { meters, seconds: Math.round(meters / profile.metersPerSecond) };
    };

    const trip = leg(input.pickup, input.destination);
    if (trip.meters === 0 || trip.seconds === 0) {
      return Promise.reject(
        new RoutingError('ROUTE_UNAVAILABLE', 'No hay ruta entre el pickup y el destino'),
      );
    }
    const pickup = input.origin ? leg(input.origin, input.pickup) : { meters: 0, seconds: 0 };

    return Promise.resolve({
      provider: 'fake',
      routingProfile: profile.name,
      pickupDistanceMeters: pickup.meters,
      pickupDurationSeconds: pickup.seconds,
      tripDistanceMeters: trip.meters,
      tripDurationSeconds: trip.seconds,
    });
  }

  health(): Promise<ProviderHealth> {
    return Promise.resolve({ provider: 'fake', status: 'up', latencyMs: 0 });
  }
}
