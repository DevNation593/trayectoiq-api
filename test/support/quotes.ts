import { expect } from 'vitest';
import type { RouteResult } from '../../src/modules/routing/domain/routing-provider.js';
import { call, type CallResult, registerUser, type Session } from './api.js';
import type { GoldenFixture } from './pricing-fixtures.js';
import type { TestApp } from './test-app.js';
import {
  createVehicle,
  idempotencyKey,
  vehicleFromFixture,
  type VehicleResponse,
} from './vehicles.js';

export const plazaGrande = { lat: -0.2201, lng: -78.5123, label: 'Plaza Grande' };
export const carolina = { lat: -0.1807, lng: -78.4841, label: 'Parque La Carolina' };
export const cumbaya = { lat: -0.2003, lng: -78.4313 };

/** Entradas de una cotizacion sin espera, regreso ni costos directos. */
export const plainInputs = {
  waitingSeconds: 0,
  emptyReturnProbability: '0',
  tollsAmount: '0',
  parkingAmount: '0',
  otherDirectCostAmount: '0',
};

export const freshRoute = { pickupMode: 'AT_PICKUP', pickup: plazaGrande, destination: carolina };

/** Esquema QuoteResult de openapi.yaml. */
export interface QuoteResultBody {
  pricingEngineVersion: string;
  currency: string;
  route: Record<string, unknown>;
  costs: Record<string, string>;
  pricing: { floor: string; minimum: string; recommended: string };
  offeredPrice: string | null;
  earningsPerHour: string | null;
  earningsPerKm: string | null;
  recommendation: string | null;
  disclaimer: string;
}

export interface PreviewBody extends QuoteResultBody {
  quoteRequestId: string;
  previewToken: string;
  routeToken: string;
  expiresAt: string;
  quota: { plan: string; remaining: number };
}

export interface DecisionBody {
  decidedAt: string;
  action: string;
  finalPrice?: string | null;
  influence: string;
  notes?: string;
}

export interface SavedQuoteBody extends QuoteResultBody {
  id: string;
  createdAt: string;
  vehicleId: string;
  pickupLabel: string | null;
  destinationLabel: string | null;
  waitingSeconds: number;
  emptyReturnProbability: string;
  decision: DecisionBody | null;
}

/** La parte de un preview o de una cotizacion guardada que describe el resultado del calculo. */
export function resultOf(body: QuoteResultBody): QuoteResultBody {
  const {
    pricingEngineVersion,
    currency,
    route,
    costs,
    pricing,
    offeredPrice,
    earningsPerHour,
    earningsPerKm,
    recommendation,
    disclaimer,
  } = body;
  return {
    pricingEngineVersion,
    currency,
    route,
    costs,
    pricing,
    offeredPrice,
    earningsPerHour,
    earningsPerKm,
    recommendation,
    disclaimer,
  };
}

/** La ruta que devolveria el proveedor para las metricas de un fixture. */
export const routeOf = (source: GoldenFixture, profile = 'motorcycle'): RouteResult => ({
  provider: 'fake',
  routingProfile: profile,
  ...source.route,
});

/** Usuario verificado con un vehiculo (por defecto, el perfil del fixture A). */
export async function driver(
  test: TestApp,
  profile = 'A_moto_10km_negotiate',
): Promise<{ session: Session; vehicle: VehicleResponse }> {
  const session = await registerUser(test);
  return { session, vehicle: await createVehicle(test, session, vehicleFromFixture(profile)) };
}

export const previewQuote = (
  test: TestApp,
  session: Session,
  body: object,
): Promise<CallResult<PreviewBody>> =>
  call<PreviewBody>(test, 'previewQuote', { token: session.accessToken, body });

/** Un preview correcto sobre una ruta nueva, con las entradas indicadas. */
export async function previewed(
  test: TestApp,
  session: Session,
  vehicle: VehicleResponse,
  inputs: object = {},
): Promise<PreviewBody> {
  const result = await previewQuote(test, session, {
    vehicleId: vehicle.id,
    ...freshRoute,
    ...plainInputs,
    ...inputs,
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

export const postQuote = (
  test: TestApp,
  session: Session,
  previewToken: string,
  headers: Record<string, string> = idempotencyKey(),
): Promise<CallResult<SavedQuoteBody>> =>
  call<SavedQuoteBody>(test, 'saveQuote', {
    token: session.accessToken,
    body: { previewToken },
    headers,
  });

/** Cotiza una ruta nueva y guarda el resultado. */
export async function savedQuote(
  test: TestApp,
  session: Session,
  vehicle: VehicleResponse,
  inputs: object = {},
): Promise<SavedQuoteBody> {
  const preview = await previewed(test, session, vehicle, inputs);
  const saved = await postQuote(test, session, preview.previewToken);
  expect(saved.status, JSON.stringify(saved.body)).toBe(201);
  return saved.body;
}
