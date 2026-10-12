import { Module } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { ServiceArea } from '../../shared/geo/geo.js';
import type { GeocodingProvider } from './domain/geocoding-provider.js';
import { GEOCODING_PROVIDER, PlacesController } from './places.controller.js';
import { FakeGeocodingProvider } from './providers/fake-geocoding.provider.js';
import { PhotonGeocodingProvider } from './providers/photon-geocoding.provider.js';

@Module({
  controllers: [PlacesController],
  providers: [
    {
      provide: GEOCODING_PROVIDER,
      inject: [APP_ENV],
      useFactory: (env: Env): GeocodingProvider =>
        env.routingProvider === 'valhalla' && env.photonUrl
          ? new PhotonGeocodingProvider({
              baseUrl: env.photonUrl,
              serviceArea: ServiceArea.parse(env.serviceAreaBbox),
            })
          : new FakeGeocodingProvider(),
    },
  ],
})
export class PlacesModule {}
