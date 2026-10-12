import type {
  CostBreakdown,
  Decision,
  EngineConfig,
  PriceLevels,
  QuoteInputs,
  RouteMetrics,
  VehicleCostProfileInput,
} from '../pricing/domain/types.js';
import type { RoutingProfile } from '../routing/domain/routing-provider.js';
import type { Plan } from '../usage/usage.service.js';
import type { VehicleDto } from '../vehicles/vehicle.dto.js';

export type PickupMode = 'AT_PICKUP' | 'CURRENT_LOCATION';

/** Esquema LocationInput de openapi.yaml. */
export type LocationInput = { placeId: string } | { lat: number; lng: number; label?: string };

/** Esquema QuotePreviewRequest de openapi.yaml. Llega ya validado en forma por ContractGuard. */
export interface PreviewRequest extends Omit<QuoteInputs, 'offeredPrice'> {
  vehicleId: string;
  routeToken?: string;
  pickupMode?: PickupMode;
  currentLocation?: LocationInput;
  pickup?: LocationInput;
  destination?: LocationInput;
  offeredPrice?: string | null;
}

export interface RoutePoint {
  lat: number;
  lng: number;
  label?: string;
}

/**
 * Contenido del routeToken: una ruta ya calculada. No lleva la ubicacion actual del conductor,
 * que solo hizo falta para rutear (06_SECURITY_PRIVACY.md seccion 1).
 */
export interface RouteTokenPayload {
  profile: RoutingProfile;
  pickupMode: PickupMode;
  pickup: RoutePoint;
  destination: RoutePoint;
  route: RouteMetrics;
  routingProvider: string;
  routingProfile: string;
}

/** Contenido del previewToken: todo lo necesario para guardar exactamente lo que el usuario vio. */
export interface PreviewTokenPayload extends RouteTokenPayload {
  quoteRequestId: string;
  vehicleId: string;
  quote: QuoteInputs;
  /** Misma forma que quotes.pricing_input_snapshot en contract/db/schema.sql. */
  pricingInputSnapshot: { vehicleCostProfile: VehicleCostProfileInput; engineConfig: EngineConfig };
}

/** Esquema QuotePreviewResponse de openapi.yaml. */
export interface PreviewResponse {
  quoteRequestId: string;
  previewToken: string;
  routeToken: string;
  expiresAt: string;
  quota: { plan: Plan; remaining: number };
  pricingEngineVersion: string;
  currency: 'USD';
  route: RouteMetrics & {
    effectiveDistanceMeters: number;
    effectiveDurationSeconds: number;
    returnMode: 'SYMMETRIC_ESTIMATE';
    routingProvider: string;
    routingProfile: string;
  };
  costs: CostBreakdown;
  pricing: PriceLevels;
  offeredPrice: string | null;
  earningsPerHour: string | null;
  earningsPerKm: string | null;
  recommendation: Decision | null;
  disclaimer: string;
}

/** El perfil de costos de un vehiculo, con los nombres que usa el Pricing Engine. */
export function toPricingProfile(vehicle: VehicleDto): VehicleCostProfileInput {
  const profile = vehicle.costProfile;
  return {
    fuelEfficiencyKmPerGallon: vehicle.fuelEfficiencyKmPerGallon,
    fuelPricePerGallon: profile.fuelPricePerGallon,
    maintenanceItems: profile.maintenanceItems,
    tireSetCost: profile.tireSetCost,
    tireUsefulLifeKm: profile.tireUsefulLifeKm,
    currentVehicleValue: vehicle.currentValue,
    expectedResidualValue: vehicle.expectedResidualValue,
    remainingUsefulLifeKm: vehicle.remainingUsefulLifeKm,
    monthlyFixedCost: profile.monthlyFixedCost,
    expectedMonthlyKm: profile.expectedMonthlyKm,
    targetHourlyIncome: profile.targetHourlyIncome,
    platformCommissionRate: profile.platformCommissionRate,
    paymentPercentageRate: profile.paymentPercentageRate,
    paymentFixedFee: profile.paymentFixedFee,
    targetProfitMargin: profile.targetProfitMargin,
  };
}
