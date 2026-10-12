import { isValidLatLng } from './geo.js';

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

export interface Place {
  id: string;
  label: string;
  lat: number;
  lng: number;
}

export class InvalidPlaceIdError extends Error {
  constructor() {
    super('El identificador de lugar no es valido');
    this.name = 'InvalidPlaceIdError';
  }
}

const round = (value: number): number => Number(value.toFixed(COORDINATE_DECIMALS));

export function encodePlaceId(place: { label: string; lat: number; lng: number }): string {
  const label = place.label.trim();
  if (!isValidLatLng(place) || label === '' || label.length > MAX_LABEL_LENGTH) {
    throw new Error('No se puede codificar un lugar sin etiqueta o con coordenadas invalidas');
  }
  const payload = JSON.stringify([round(place.lat), round(place.lng), label]);
  return PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
}

/** Lanza InvalidPlaceIdError si el id no lo emitio esta API o esta dañado. */
export function decodePlaceId(id: string): Place {
  if (
    typeof id !== 'string' ||
    !id.startsWith(PREFIX) ||
    !/^[A-Za-z0-9_-]+$/.test(id.slice(PREFIX.length))
  ) {
    throw new InvalidPlaceIdError();
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(id.slice(PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new InvalidPlaceIdError();
  }
  if (!Array.isArray(payload) || payload.length !== 3) {
    throw new InvalidPlaceIdError();
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
    throw new InvalidPlaceIdError();
  }
  return { id, label, lat, lng };
}
