import { describe, expect, it } from 'vitest';
import {
  GeoError,
  haversineMeters,
  isValidLatLng,
  QUITO_SERVICE_AREA,
  ServiceArea,
} from '../../src/shared/geo/geo.js';

const plazaGrande = { lat: -0.2201, lng: -78.5123 };
const carolina = { lat: -0.1807, lng: -78.4841 };
const guayaquil = { lat: -2.1894, lng: -79.8891 };

describe('isValidLatLng', () => {
  it('acepta coordenadas dentro de rango', () => {
    expect(isValidLatLng(plazaGrande)).toBe(true);
    expect(isValidLatLng({ lat: 90, lng: -180 })).toBe(true);
  });

  it.each([
    { lat: 91, lng: 0 },
    { lat: 0, lng: 181 },
    { lat: Number.NaN, lng: 0 },
    { lat: 0, lng: Number.POSITIVE_INFINITY },
  ])('rechaza %j', (point) => {
    expect(isValidLatLng(point)).toBe(false);
  });
});

describe('haversineMeters', () => {
  it('es cero entre un punto y si mismo', () => {
    expect(haversineMeters(plazaGrande, plazaGrande)).toBe(0);
  });

  it('mide ~5.4 km en linea recta entre la Plaza Grande y La Carolina', () => {
    const meters = haversineMeters(plazaGrande, carolina);
    expect(meters).toBeGreaterThan(5_300);
    expect(meters).toBeLessThan(5_500);
  });

  it('es simetrica', () => {
    expect(haversineMeters(plazaGrande, carolina)).toBeCloseTo(
      haversineMeters(carolina, plazaGrande),
      6,
    );
  });
});

describe('ServiceArea', () => {
  it('lee "minLng,minLat,maxLng,maxLat"', () => {
    const area = ServiceArea.parse('-78.65,-0.45,-78.25,0.08');
    expect(area.toBbox()).toBe('-78.65,-0.45,-78.25,0.08');
  });

  it('contiene el centro y el norte de Quito y excluye Guayaquil', () => {
    expect(QUITO_SERVICE_AREA.contains(plazaGrande)).toBe(true);
    expect(QUITO_SERVICE_AREA.contains(carolina)).toBe(true);
    expect(QUITO_SERVICE_AREA.contains(guayaquil)).toBe(false);
  });

  it('el borde pertenece al area', () => {
    const area = ServiceArea.parse('-78.65,-0.45,-78.25,0.08');
    expect(area.contains({ lat: 0.08, lng: -78.25 })).toBe(true);
    expect(area.contains({ lat: 0.0801, lng: -78.25 })).toBe(false);
  });

  it('una coordenada invalida nunca esta dentro', () => {
    expect(QUITO_SERVICE_AREA.contains({ lat: Number.NaN, lng: -78.5 })).toBe(false);
  });

  it('calcula el centro', () => {
    const center = ServiceArea.parse('-78.6,-0.4,-78.2,0').center();
    expect(center.lat).toBeCloseTo(-0.2, 9);
    expect(center.lng).toBeCloseTo(-78.4, 9);
  });

  it.each([
    '',
    '1,2,3',
    'a,b,c,d',
    '-78.25,-0.45,-78.65,0.08',
    '-78.65,0.08,-78.25,-0.45',
    '0,0,0,95',
  ])('rechaza el bbox %j', (bbox) => {
    expect(() => ServiceArea.parse(bbox)).toThrow(GeoError);
  });
});
