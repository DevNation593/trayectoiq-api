export interface LatLng {
  lat: number;
  lng: number;
}

export class GeoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeoError';
  }
}

const EARTH_RADIUS_METERS = 6_371_008.8;
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export function isValidLatLng(point: LatLng): boolean {
  return (
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    Math.abs(point.lat) <= 90 &&
    Math.abs(point.lng) <= 180
  );
}

/** Distancia en linea recta sobre la esfera. Para estimar y comparar, no para cobrar. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Caja geografica donde el producto da servicio (04_ARCHITECTURE.md seccion 4). */
export class ServiceArea {
  private constructor(
    private readonly minLng: number,
    private readonly minLat: number,
    private readonly maxLng: number,
    private readonly maxLat: number,
  ) {}

  /** Formato "minLng,minLat,maxLng,maxLat", el mismo que usan Photon y la variable SERVICE_AREA_BBOX. */
  static parse(bbox: string): ServiceArea {
    const parts = bbox.split(',').map((part) => (part.trim() === '' ? Number.NaN : Number(part)));
    const [minLng, minLat, maxLng, maxLat] = parts;
    if (
      parts.length !== 4 ||
      minLng === undefined ||
      minLat === undefined ||
      maxLng === undefined ||
      maxLat === undefined ||
      !isValidLatLng({ lat: minLat, lng: minLng }) ||
      !isValidLatLng({ lat: maxLat, lng: maxLng }) ||
      minLng >= maxLng ||
      minLat >= maxLat
    ) {
      throw new GeoError(`bbox invalido, se esperaba "minLng,minLat,maxLng,maxLat": "${bbox}"`);
    }
    return new ServiceArea(minLng, minLat, maxLng, maxLat);
  }

  contains(point: LatLng): boolean {
    return (
      isValidLatLng(point) &&
      point.lng >= this.minLng &&
      point.lng <= this.maxLng &&
      point.lat >= this.minLat &&
      point.lat <= this.maxLat
    );
  }

  center(): LatLng {
    return { lat: (this.minLat + this.maxLat) / 2, lng: (this.minLng + this.maxLng) / 2 };
  }

  toBbox(): string {
    return `${this.minLng},${this.minLat},${this.maxLng},${this.maxLat}`;
  }
}

/**
 * Distrito Metropolitano de Quito y valles (Cumbaya, Tumbaco, Los Chillos, aeropuerto de Tababela,
 * Mitad del Mundo). Valor inicial: se ajusta con SERVICE_AREA_BBOX sin tocar codigo.
 */
export const QUITO_SERVICE_AREA = ServiceArea.parse('-78.65,-0.45,-78.25,0.08');
