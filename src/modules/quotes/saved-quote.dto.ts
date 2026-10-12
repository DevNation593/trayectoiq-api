import type { Quote, QuoteCostBreakdown, QuoteDecision } from '../../generated/prisma/client.js';
import { Fraction } from '../../shared/fraction/fraction.js';
import type { CostBreakdown, Decision, PriceLevels } from '../pricing/domain/types.js';
import type { PreviewResponse } from './quote.dto.js';

export const DISCLAIMER =
  'Los valores son estimaciones a partir de los costos que configuraste y de una ruta calculada. ' +
  'No son una tarifa oficial ni garantizan una ganancia.';

export type DecisionAction =
  | 'ACCEPTED_ORIGINAL_OFFER'
  | 'NEGOTIATED_AND_ACCEPTED'
  | 'REJECTED'
  | 'CANCELLED_BY_OTHER_PARTY'
  | 'UNKNOWN';

export type Influence = 'YES' | 'NO' | 'UNSURE';

/** Esquema QuoteDecision de openapi.yaml. */
export interface DecisionDto {
  decidedAt: string;
  action: DecisionAction;
  finalPrice: string | null;
  influence: Influence;
  notes?: string;
}

/** Esquema SavedQuote de openapi.yaml. */
export interface SavedQuoteDto {
  id: string;
  createdAt: string;
  vehicleId: string;
  pickupLabel: string | null;
  destinationLabel: string | null;
  waitingSeconds: number;
  emptyReturnProbability: string;
  decision: DecisionDto | null;
  pricingEngineVersion: string;
  currency: 'USD';
  route: PreviewResponse['route'];
  costs: CostBreakdown;
  pricing: PriceLevels;
  offeredPrice: string | null;
  earningsPerHour: string | null;
  earningsPerKm: string | null;
  recommendation: Decision | null;
  disclaimer: string;
}

export type QuoteRow = Quote & {
  quoteCostBreakdown: QuoteCostBreakdown | null;
  quoteDecision: QuoteDecision | null;
};

export const WITH_DETAIL = { quoteCostBreakdown: true, quoteDecision: true } as const;

interface DecimalLike {
  toFixed(places?: number): string;
}

/**
 * Un precio que escribio el usuario, tal como lo devuelve la API: con al menos dos decimales y sin
 * ceros de relleno a partir del tercero ("7" -> "7.00", "7.125" -> "7.125").
 */
export function priceText(value: string): string {
  const [integer = '0', fraction = ''] = value.split('.');
  return `${integer}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`;
}

const optionalPrice = (value: DecimalLike | null): string | null =>
  value === null ? null : priceText(value.toFixed());

/** Un valor raw guardado (10 decimales) como lo muestra la API: 2 decimales HALF_UP. */
const money = (raw: DecimalLike): string => Fraction.parse(raw.toFixed()).toFixedHalfUp(2);
const optionalMoney = (raw: DecimalLike | null): string | null =>
  raw === null ? null : money(raw);

export function toDecisionDto(decision: QuoteDecision): DecisionDto {
  return {
    decidedAt: decision.decidedAt.toISOString(),
    action: decision.action,
    finalPrice: optionalPrice(decision.finalPrice),
    influence: decision.influence,
    ...(decision.notes === null ? {} : { notes: decision.notes }),
  };
}

/**
 * Una cotizacion guardada, armada solo con lo que quedo en la base: lo guardado no se recalcula
 * con el motor (04_ARCHITECTURE.md seccion 1). Distancia y tiempo efectivos no tienen columna:
 * se derivan de la ruta y las entradas guardadas con la formula de 03_PRICING_ENGINE.md seccion 4.
 */
export function toSavedQuoteDto(row: QuoteRow): SavedQuoteDto {
  const breakdown = row.quoteCostBreakdown;
  if (!breakdown) {
    throw new Error(`La cotizacion ${row.id} no tiene desglose de costos`);
  }
  const returnProbability = Fraction.parse(row.emptyReturnProbability.toFixed());
  const withReturn = (pickup: number, trip: number): Fraction =>
    Fraction.parse(pickup)
      .add(Fraction.parse(trip))
      .add(Fraction.parse(trip).mul(returnProbability));

  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    vehicleId: row.vehicleId,
    pickupLabel: row.pickupLabel,
    destinationLabel: row.destinationLabel,
    waitingSeconds: row.waitingSeconds,
    emptyReturnProbability: row.emptyReturnProbability.toFixed(),
    decision: row.quoteDecision ? toDecisionDto(row.quoteDecision) : null,
    pricingEngineVersion: row.pricingEngineVersion,
    currency: 'USD',
    route: {
      pickupDistanceMeters: row.pickupDistanceMeters,
      pickupDurationSeconds: row.pickupDurationSeconds,
      tripDistanceMeters: row.tripDistanceMeters,
      tripDurationSeconds: row.tripDurationSeconds,
      effectiveDistanceMeters: Number(
        withReturn(row.pickupDistanceMeters, row.tripDistanceMeters).toFixedHalfUp(0),
      ),
      effectiveDurationSeconds: Number(
        withReturn(row.pickupDurationSeconds, row.tripDurationSeconds)
          .add(Fraction.parse(row.waitingSeconds))
          .toFixedHalfUp(0),
      ),
      returnMode: 'SYMMETRIC_ESTIMATE',
      routingProvider: row.routingProvider,
      routingProfile: row.routingProfile,
    },
    costs: {
      fuel: money(breakdown.fuelCost),
      maintenance: money(breakdown.maintenanceCost),
      tires: money(breakdown.tireCost),
      depreciation: money(breakdown.depreciationCost),
      fixed: money(breakdown.fixedCost),
      tolls: money(breakdown.tollsCost),
      parking: money(breakdown.parkingCost),
      other: money(breakdown.otherCost),
      operating: money(row.operatingCostRaw),
      targetCompensation: money(breakdown.driverTargetCompensation),
    },
    pricing: {
      floor: row.floorPrice.toFixed(2),
      minimum: row.minimumPrice.toFixed(2),
      recommended: row.recommendedPrice.toFixed(2),
    },
    offeredPrice: optionalPrice(row.offeredPrice),
    earningsPerHour: optionalMoney(row.earningsPerHourRaw),
    earningsPerKm: optionalMoney(row.earningsPerKmRaw),
    recommendation: row.recommendation,
    disclaimer: DISCLAIMER,
  };
}
