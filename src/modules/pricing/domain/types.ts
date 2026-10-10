/**
 * Tipos del Pricing Engine. Tienen la misma forma que contract/fixtures/pricing-engine-golden.json:
 * dinero, tasas y distancias en km como strings decimales; metros y segundos como enteros.
 */

export const PRICING_ENGINE_VERSION = '1.0.0';

export interface RouteMetrics {
  pickupDistanceMeters: number;
  pickupDurationSeconds: number;
  tripDistanceMeters: number;
  tripDurationSeconds: number;
}

export interface QuoteInputs {
  waitingSeconds: number;
  emptyReturnProbability: string;
  tollsAmount: string;
  parkingAmount: string;
  otherDirectCostAmount: string;
  offeredPrice: string | null;
}

export interface MaintenanceItemInput {
  name: string;
  cost: string;
  intervalKm: string;
  enabled: boolean;
}

export interface VehicleCostProfileInput {
  fuelEfficiencyKmPerGallon: string | null;
  fuelPricePerGallon: string;
  maintenanceItems: MaintenanceItemInput[];
  tireSetCost: string;
  tireUsefulLifeKm: string | null;
  currentVehicleValue: string;
  expectedResidualValue: string;
  remainingUsefulLifeKm: string | null;
  monthlyFixedCost: string;
  expectedMonthlyKm: string | null;
  targetHourlyIncome: string;
  platformCommissionRate: string;
  paymentPercentageRate: string;
  paymentFixedFee: string;
  targetProfitMargin: string;
}

export interface PricingInput {
  route: RouteMetrics;
  quote: QuoteInputs;
  vehicleCostProfile: VehicleCostProfileInput;
}

export interface EngineConfig {
  thresholdStep: string;
  recommendedStep: string;
  returnMode: 'SYMMETRIC_ESTIMATE';
}

/** Configuracion de Ecuador v1 (03_PRICING_ENGINE.md seccion 9.1). */
export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  thresholdStep: '0.01',
  recommendedStep: '0.05',
  returnMode: 'SYMMETRIC_ESTIMATE',
};

export type Decision = 'ACCEPT' | 'NEGOTIATE' | 'REJECT';

export interface CostBreakdown {
  fuel: string;
  maintenance: string;
  tires: string;
  depreciation: string;
  fixed: string;
  tolls: string;
  parking: string;
  other: string;
  operating: string;
  targetCompensation: string;
}

export interface PriceLevels {
  floor: string;
  minimum: string;
  recommended: string;
}

export interface PricingResult {
  pricingEngineVersion: string;
  /** Valores `Raw`: 10 decimales HALF_UP, para auditoria y base de datos. */
  effectiveDistanceKmRaw: string;
  effectiveHoursRaw: string;
  costsRaw: CostBreakdown;
  pricesRaw: PriceLevels;
  /** Umbrales cobrables, ya redondeados hacia arriba; contra ellos se compara la oferta. */
  thresholds: PriceLevels;
  decision: Decision | null;
  earningsPerHourRaw: string | null;
  earningsPerKmRaw: string | null;
  /** Lo que devuelve la API: 2 decimales HALF_UP; metros y segundos enteros HALF_UP. */
  api: {
    effectiveDistanceMeters: number;
    effectiveDurationSeconds: number;
    costs: CostBreakdown;
    earningsPerHour: string | null;
    earningsPerKm: string | null;
  };
}
