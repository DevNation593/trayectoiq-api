import { isValidLatLng } from '../../../shared/geo/geo.js';
import { GeocodingError, type ResolvedPlace } from './geocoding-provider.js';

/**
 * Un placeId es autocontenido: lleva etiqueta y coordenadas. Photon no ofrece busqueda por id,
 * asi que resolver un lugar no puede depender de volver a consultarlo.
 *
 * Formato: "p1." + base64url(JSON [lat, lng, label]). No va firmado: el contrato ya acepta
 * coordenadas sueltas en LocationInput, de modo que un id inventado no concede nada.
 */
const PREFIX = 'p1.';
const COORDINATE_DECIMALS = 6;
const MAX_LABEL_LENGTH = 200;

const round = (value: number): number => Number(value.toFixed(COORDINATE_DECIMALS));

export function encodePlaceId(place: { label: string; lat: number; lng: number }): string {
  const label = place.label.trim();
  if (!isValidLatLng(place) || label === '' || label.length > MAX_LABEL_LENGTH) {
    throw new Error('No se puede codificar un lugar sin etiqueta o con coordenadas invalidas');
  }
  const payload = JSON.stringify([round(place.lat), round(place.lng), label]);
  return PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodePlaceId(id: string): ResolvedPlace {
  const notFound = (): GeocodingError =>
    new GeocodingError('PLACE_NOT_FOUND', 'El identificador de lugar no es valido');

  if (typeof id !== 'string' || !id.startsWith(PREFIX) || !/^[A-Za-z0-9_-]+$/.test(id.slice(3))) {
    throw notFound();
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(id.slice(PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw notFound();
  }
  if (!Array.isArray(payload) || payload.length !== 3) {
    throw notFound();
  }
  const [lat, lng, label] = payload as unknown[];
  if (
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    typeof label !== 'string' ||
    label.trim() === '' ||
    label.length > MAX_LABEL_LENGTH ||
    !isValidLatLng({ lat, lng })
  ) {
    throw notFound();
  }
  return { id, label, lat, lng };
}
