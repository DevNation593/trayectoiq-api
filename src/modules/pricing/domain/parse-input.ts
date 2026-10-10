import { Fraction } from '../../../shared/fraction/fraction.js';
import { PricingConfigError } from './errors.js';
import type { EngineConfig, PricingInput } from './types.js';

/** Entrada convertida a fracciones exactas. Un divisor ausente queda en null. */
export interface ParsedInput {
  pickupMeters: Fraction;
  pickupSeconds: Fraction;
  tripMeters: Fraction;
  tripSeconds: Fraction;
  waitingSeconds: Fraction;
  returnProbability: Fraction;
  tolls: Fraction;
  parking: Fraction;
  other: Fraction;
  offer: Fraction | null;
  fuelEfficiency: Fraction | null;
  fuelPrice: Fraction;
  maintenanceItems: { cost: Fraction; intervalKm: Fraction; enabled: boolean }[];
  tireSetCost: Fraction;
  tireUsefulLifeKm: Fraction | null;
  currentVehicleValue: Fraction;
  expectedResidualValue: Fraction;
  remainingUsefulLifeKm: Fraction | null;
  monthlyFixedCost: Fraction;
  expectedMonthlyKm: Fraction | null;
  targetHourlyIncome: Fraction;
  platformCommissionRate: Fraction;
  paymentPercentageRate: Fraction;
  paymentFixedFee: Fraction;
  targetProfitMargin: Fraction;
}

export interface ParsedConfig {
  thresholdStep: Fraction;
  recommendedStep: Fraction;
}

const optional = (value: string | null): Fraction | null =>
  value === null ? null : Fraction.parse(value);

/**
 * Convierte la entrada en fracciones. El formato (decimales en texto, enteros en metros y segundos)
 * lo garantiza la validacion de esquema de la API; si aun asi llega un valor mal formado,
 * Fraction.parse lanza FractionError en vez de dejar que se calcule con basura.
 */
export function parseInput({
  route,
  quote,
  vehicleCostProfile: profile,
}: PricingInput): ParsedInput {
  return {
    pickupMeters: Fraction.parse(route.pickupDistanceMeters),
    pickupSeconds: Fraction.parse(route.pickupDurationSeconds),
    tripMeters: Fraction.parse(route.tripDistanceMeters),
    tripSeconds: Fraction.parse(route.tripDurationSeconds),
    waitingSeconds: Fraction.parse(quote.waitingSeconds),
    returnProbability: Fraction.parse(quote.emptyReturnProbability),
    tolls: Fraction.parse(quote.tollsAmount),
    parking: Fraction.parse(quote.parkingAmount),
    other: Fraction.parse(quote.otherDirectCostAmount),
    offer: optional(quote.offeredPrice),
    fuelEfficiency: optional(profile.fuelEfficiencyKmPerGallon),
    fuelPrice: Fraction.parse(profile.fuelPricePerGallon),
    maintenanceItems: profile.maintenanceItems.map((item) => ({
      cost: Fraction.parse(item.cost),
      intervalKm: Fraction.parse(item.intervalKm),
      enabled: item.enabled,
    })),
    tireSetCost: Fraction.parse(profile.tireSetCost),
    tireUsefulLifeKm: optional(profile.tireUsefulLifeKm),
    currentVehicleValue: Fraction.parse(profile.currentVehicleValue),
    expectedResidualValue: Fraction.parse(profile.expectedResidualValue),
    remainingUsefulLifeKm: optional(profile.remainingUsefulLifeKm),
    monthlyFixedCost: Fraction.parse(profile.monthlyFixedCost),
    expectedMonthlyKm: optional(profile.expectedMonthlyKm),
    targetHourlyIncome: Fraction.parse(profile.targetHourlyIncome),
    platformCommissionRate: Fraction.parse(profile.platformCommissionRate),
    paymentPercentageRate: Fraction.parse(profile.paymentPercentageRate),
    paymentFixedFee: Fraction.parse(profile.paymentFixedFee),
    targetProfitMargin: Fraction.parse(profile.targetProfitMargin),
  };
}

export function parseConfig(config: EngineConfig): ParsedConfig {
  if (config.returnMode !== 'SYMMETRIC_ESTIMATE') {
    throw new PricingConfigError(`returnMode no soportado: ${String(config.returnMode)}`);
  }
  const thresholdStep = Fraction.parse(config.thresholdStep);
  const recommendedStep = Fraction.parse(config.recommendedStep);
  if (thresholdStep.sign() <= 0 || recommendedStep.sign() <= 0) {
    throw new PricingConfigError('thresholdStep y recommendedStep deben ser mayores que cero');
  }
  return { thresholdStep, recommendedStep };
}
