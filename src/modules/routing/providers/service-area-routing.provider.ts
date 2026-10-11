import type { ServiceArea } from '../../../shared/geo/geo.js';
import type { ProviderHealth } from '../../../shared/providers/provider-health.js';
import {
  type RouteInput,
  type RouteResult,
  RoutingError,
  type RoutingProvider,
} from '../domain/routing-provider.js';

/**
 * Aplica el area de servicio delante de cualquier proveedor: si un punto queda fuera,
 * responde OUT_OF_SERVICE_AREA sin gastar una llamada de ruta.
 */
export class ServiceAreaRoutingProvider implements RoutingProvider {
  constructor(
    private readonly inner: RoutingProvider,
    private readonly area: ServiceArea,
  ) {}

  route(input: RouteInput): Promise<RouteResult> {
    const points = [input.pickup, input.destination, ...(input.origin ? [input.origin] : [])];
    if (!points.every((point) => this.area.contains(point))) {
      return Promise.reject(
        new RoutingError('OUT_OF_SERVICE_AREA', 'Algun punto esta fuera del area de servicio'),
      );
    }
    return this.inner.route(input);
  }

  health(): Promise<ProviderHealth> {
    return this.inner.health();
  }
}
