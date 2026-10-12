import {
  decodePlaceId as decodeSharedPlaceId,
  InvalidPlaceIdError,
} from '../../../shared/geo/place-id.js';
import { GeocodingError, type ResolvedPlace } from './geocoding-provider.js';

export { encodePlaceId } from '../../../shared/geo/place-id.js';

/** Igual que el decodificador compartido, pero con el error del dominio de lugares. */
export function decodePlaceId(id: string): ResolvedPlace {
  try {
    return decodeSharedPlaceId(id);
  } catch (error) {
    if (error instanceof InvalidPlaceIdError) {
      throw new GeocodingError('PLACE_NOT_FOUND', error.message);
    }
    throw error;
  }
}
