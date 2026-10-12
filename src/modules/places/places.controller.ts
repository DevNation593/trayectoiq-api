import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { Operation } from '../../shared/contract/contract.guard.js';
import { AppError } from '../../shared/errors/app-error.js';
import { RateLimit } from '../../shared/rate-limit/rate-limit.guard.js';
import {
  GeocodingError,
  type GeocodingProvider,
  type PlaceSuggestion,
  type ResolvedPlace,
} from './domain/geocoding-provider.js';

export const GEOCODING_PROVIDER = Symbol('GEOCODING_PROVIDER');

const toAppError = (error: unknown): unknown => {
  if (!(error instanceof GeocodingError)) {
    return error;
  }
  return error.code === 'PLACE_NOT_FOUND'
    ? new AppError(404, 'PLACE_NOT_FOUND', 'El lugar no existe')
    : new AppError(
        503,
        'GEOCODING_PROVIDER_UNAVAILABLE',
        'La busqueda de lugares no esta disponible; elige el punto en el mapa',
      );
};

/** Busqueda de lugares. Siempre con sesion: no hay geocoder abierto al publico. */
@Controller('places')
export class PlacesController {
  constructor(@Inject(GEOCODING_PROVIDER) private readonly geocoding: GeocodingProvider) {}

  @Get('autocomplete')
  @Operation('autocompletePlaces')
  @RateLimit('autocomplete')
  async autocomplete(
    @Query() query: { q: string; lat?: string; lng?: string },
  ): Promise<PlaceSuggestion[]> {
    // El contrato valida cada coordenada por separado; que vengan las dos o ninguna se comprueba aqui.
    if ((query.lat === undefined) !== (query.lng === undefined)) {
      throw new AppError(422, 'VALIDATION_FAILED', 'La peticion no es valida', {
        errors: [
          {
            field: query.lat === undefined ? 'lat' : 'lng',
            code: 'required',
            message: 'lat y lng van juntos',
          },
        ],
      });
    }
    const bias =
      query.lat !== undefined && query.lng !== undefined
        ? { lat: Number(query.lat), lng: Number(query.lng) }
        : undefined;
    try {
      return await this.geocoding.autocomplete(query.q, bias);
    } catch (error) {
      throw toAppError(error);
    }
  }

  @Get(':placeId')
  @Operation('resolvePlace')
  async resolve(@Param('placeId') placeId: string): Promise<ResolvedPlace> {
    try {
      return await this.geocoding.resolve(placeId);
    } catch (error) {
      throw toAppError(error);
    }
  }
}
