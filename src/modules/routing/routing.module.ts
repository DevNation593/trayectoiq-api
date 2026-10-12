import { Module } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { ServiceArea } from '../../shared/geo/geo.js';
import type { RoutingProvider } from './domain/routing-provider.js';
import { FakeRoutingProvider } from './providers/fake-routing.provider.js';
import { ServiceAreaRoutingProvider } from './providers/service-area-routing.provider.js';
import { ValhallaRoutingProvider } from './providers/valhalla-routing.provider.js';

export const ROUTING_PROVIDER = Symbol('ROUTING_PROVIDER');

/** El proveedor configurado, siempre detras de la comprobacion del area de servicio. */
export function buildRoutingProvider(env: Env, inner?: RoutingProvider): RoutingProvider {
  const provider =
    inner ??
    (env.routingProvider === 'valhalla' && env.valhallaUrl
      ? new ValhallaRoutingProvider({ baseUrl: env.valhallaUrl })
      : new FakeRoutingProvider());
  return new ServiceAreaRoutingProvider(provider, ServiceArea.parse(env.serviceAreaBbox));
}

@Module({
  providers: [
    {
      provide: ROUTING_PROVIDER,
      inject: [APP_ENV],
      useFactory: (env: Env): RoutingProvider => buildRoutingProvider(env),
    },
  ],
  exports: [ROUTING_PROVIDER],
})
export class RoutingModule {}
