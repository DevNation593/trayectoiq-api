import { Fraction } from '../../../shared/fraction/fraction.js';
import { parseConfig, parseInput } from './parse-input.js';
import {
  type CostBreakdown,
  type Decision,
  type EngineConfig,
  PRICING_ENGINE_VERSION,
  type PriceLevels,
  type PricingInput,
  type PricingResult,
} from './types.js';
import { validate } from './validate.js';

const METERS_PER_KM = Fraction.parse(1000);
const SECONDS_PER_HOUR = Fraction.parse(3600);

/** Decimales de los valores raw y de los valores que devuelve la API (seccion 2.2). */
const RAW_PLACES = 10;
const MONEY_PLACES = 2;

const sum = (values: Fraction[]): Fraction =>
  values.reduce((total, value) => total.add(value), Fraction.ZERO);

const mapValues = <K extends string>(
  record: Record<K, Fraction>,
  format: (value: Fraction) => string,
): Record<K, string> =>
  Object.fromEntries(
    Object.entries<Fraction>(record).map(([key, value]) => [key, format(value)]),
  ) as Record<K, string>;

/**
 * Pricing Engine v1.0.0 (03_PRICING_ENGINE.md). Funcion pura: sin reloj, red ni base de datos.
 * Toda la aritmetica es racional exacta; el redondeo ocurre una sola vez, al serializar.
 * Lanza PricingError si la entrada incumple una regla de dominio.
 */
export function calculate(input: PricingInput, config: EngineConfig): PricingResult {
  const { thresholdStep, recommendedStep } = parseConfig(config);
  const parsed = parseInput(input);
  validate(parsed);

  // Seccion 4: routing efectivo. SYMMETRIC_ESTIMATE: el regreso repite el trayecto.
  const tripKm = parsed.tripMeters.div(METERS_PER_KM);
  const tripHours = parsed.tripSeconds.div(SECONDS_PER_HOUR);
  const distanceKm = parsed.pickupMeters
    .div(METERS_PER_KM)
    .add(tripKm)
    .add(tripKm.mul(parsed.returnProbability));
  const hours = parsed.pickupSeconds
    .div(SECONDS_PER_HOUR)
    .add(tripHours)
    .add(tripHours.mul(parsed.returnProbability))
    .add(parsed.waitingSeconds.div(SECONDS_PER_HOUR));

  // Seccion 5: costos operativos. validate() garantiza cada divisor cuando su costo es positivo.
  const perKm = (cost: Fraction, divisor: Fraction | null): Fraction =>
    cost.sign() > 0 && divisor !== null ? cost.div(divisor) : Fraction.ZERO;

  const maintenancePerKm = sum(
    parsed.maintenanceItems
      .filter((item) => item.enabled)
      .map((item) => item.cost.div(item.intervalKm)),
  );
  const depreciable = Fraction.max(
    Fraction.ZERO,
    parsed.currentVehicleValue.sub(parsed.expectedResidualValue),
  );

  const components = {
    fuel: distanceKm.div(parsed.fuelEfficiency ?? Fraction.ONE).mul(parsed.fuelPrice),
    maintenance: distanceKm.mul(maintenancePerKm),
    tires: distanceKm.mul(perKm(parsed.tireSetCost, parsed.tireUsefulLifeKm)),
    depreciation: distanceKm.mul(perKm(depreciable, parsed.remainingUsefulLifeKm)),
    fixed: distanceKm.mul(perKm(parsed.monthlyFixedCost, parsed.expectedMonthlyKm)),
    tolls: parsed.tolls,
    parking: parsed.parking,
    other: parsed.other,
  };
  const operating = sum(Object.values(components));

  // Secciones 6 a 8: remuneracion objetivo, comisiones y precios raw.
  const targetCompensation = hours.mul(parsed.targetHourlyIncome);
  const rate = parsed.platformCommissionRate.add(parsed.paymentPercentageRate);
  const netShare = Fraction.ONE.sub(rate);
  const prices = {
    floor: operating.add(parsed.paymentFixedFee).div(netShare),
    minimum: operating.add(targetCompensation).add(parsed.paymentFixedFee).div(netShare),
    recommended: operating
      .add(targetCompensation)
      .add(parsed.paymentFixedFee)
      .div(netShare.sub(parsed.targetProfitMargin)),
  };

  // Seccion 9: umbrales cobrables, siempre hacia arriba, y decision contra esos umbrales.
  const thresholds = {
    floor: prices.floor.ceilToStep(thresholdStep),
    minimum: prices.minimum.ceilToStep(thresholdStep),
    recommended: prices.recommended.ceilToStep(recommendedStep),
  };

  let decision: Decision | null = null;
  let earningsPerHour: Fraction | null = null;
  let earningsPerKm: Fraction | null = null;
  if (parsed.offer !== null) {
    decision =
      parsed.offer.compare(thresholds.recommended) >= 0
        ? 'ACCEPT'
        : parsed.offer.compare(thresholds.minimum) >= 0
          ? 'NEGOTIATE'
          : 'REJECT';
    // Seccion 10: ganancia real del conductor con esa oferta.
    const earnings = parsed.offer.mul(netShare).sub(parsed.paymentFixedFee).sub(operating);
    earningsPerHour = earnings.div(hours);
    earningsPerKm = earnings.div(distanceKm);
  }

  const raw = (value: Fraction): string => value.toFixedHalfUp(RAW_PLACES);
  const money = (value: Fraction): string => value.toFixedHalfUp(MONEY_PLACES);
  const orNull = (value: Fraction | null, format: (value: Fraction) => string): string | null =>
    value === null ? null : format(value);

  const costs = { ...components, operating, targetCompensation };

  return {
    pricingEngineVersion: PRICING_ENGINE_VERSION,
    effectiveDistanceKmRaw: raw(distanceKm),
    effectiveHoursRaw: raw(hours),
    costsRaw: mapValues(costs, raw) satisfies CostBreakdown,
    pricesRaw: mapValues(prices, raw) satisfies PriceLevels,
    thresholds: mapValues(thresholds, money) satisfies PriceLevels,
    decision,
    earningsPerHourRaw: orNull(earningsPerHour, raw),
    earningsPerKmRaw: orNull(earningsPerKm, raw),
    api: {
      effectiveDistanceMeters: Number(distanceKm.mul(METERS_PER_KM).toFixedHalfUp(0)),
      effectiveDurationSeconds: Number(hours.mul(SECONDS_PER_HOUR).toFixedHalfUp(0)),
      costs: mapValues(costs, money) satisfies CostBreakdown,
      earningsPerHour: orNull(earningsPerHour, money),
      earningsPerKm: orNull(earningsPerKm, money),
    },
  };
}
