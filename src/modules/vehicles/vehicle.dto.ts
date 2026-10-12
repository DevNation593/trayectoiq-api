import type {
  MaintenanceItem,
  Vehicle,
  VehicleCostProfile,
} from '../../generated/prisma/client.js';
import type { FieldError } from '../../shared/contract/contract.js';
import { Fraction } from '../../shared/fraction/fraction.js';

/** Esquema MaintenanceItem de openapi.yaml. */
export interface MaintenanceItemDto {
  name: string;
  cost: string;
  intervalKm: string;
  enabled: boolean;
}

/** Esquema VehicleCostProfile de openapi.yaml. */
export interface CostProfileDto {
  fuelPricePerGallon: string;
  tireSetCost: string;
  tireUsefulLifeKm: string | null;
  monthlyFixedCost: string;
  expectedMonthlyKm: string | null;
  targetHourlyIncome: string;
  platformCommissionRate: string;
  paymentPercentageRate: string;
  paymentFixedFee: string;
  targetProfitMargin: string;
  maintenanceItems: MaintenanceItemDto[];
}

/** Esquema VehicleUpsert de openapi.yaml. Llega ya validado en forma por ContractGuard. */
export interface VehicleInput {
  type: 'MOTORCYCLE' | 'CAR';
  brand?: string;
  model?: string;
  year?: number;
  fuelType: 'GASOLINE' | 'DIESEL' | 'HYBRID';
  fuelEfficiencyKmPerGallon: string;
  isDefault?: boolean;
  currentValue: string;
  expectedResidualValue: string;
  remainingUsefulLifeKm?: string | null;
  costProfile: CostProfileDto;
}

export type VehicleDto = Omit<VehicleInput, 'remainingUsefulLifeKm' | 'isDefault'> & {
  id: string;
  isDefault: boolean;
  remainingUsefulLifeKm: string | null;
};

export type VehicleWithProfile = Vehicle & {
  vehicleCostProfiles: (VehicleCostProfile & { maintenanceItems: MaintenanceItem[] })[];
};

/** Suma de comisiones y margen a partir de la cual el precio se dispara (03_PRICING_ENGINE.md seccion 7). */
const MAX_RATE_SUM = Fraction.parse('0.90');

/**
 * Reglas de dominio del perfil de costos: las mismas que aplica el Pricing Engine (seccion 14),
 * comprobadas al guardar para que ningun vehiculo guardado haga fallar despues una cotizacion.
 * Un test recorre los casos invalidos del motor y exige que aqui tambien se rechacen.
 */
export function validateVehicle(input: VehicleInput): FieldError[] {
  const errors: FieldError[] = [];
  const positive = (value: string | null | undefined): boolean =>
    value !== null && value !== undefined && Fraction.parse(value).sign() > 0;
  const require = (field: string, value: string | null | undefined, message: string): void => {
    if (!positive(value)) errors.push({ field, code: 'divisorRequired', message });
  };
  const profile = input.costProfile;

  require('fuelEfficiencyKmPerGallon', input.fuelEfficiencyKmPerGallon, 'Debe ser mayor que cero');

  const depreciates =
    Fraction.parse(input.currentValue).compare(Fraction.parse(input.expectedResidualValue)) > 0;
  if (depreciates) {
    require('remainingUsefulLifeKm', input.remainingUsefulLifeKm, 'Hace falta cuando el valor actual supera al valor residual');
  }
  if (positive(profile.tireSetCost)) {
    require('costProfile.tireUsefulLifeKm', profile.tireUsefulLifeKm, 'Hace falta cuando hay costo de neumaticos');
  }
  if (positive(profile.monthlyFixedCost)) {
    require('costProfile.expectedMonthlyKm', profile.expectedMonthlyKm, 'Hace falta cuando hay costos fijos mensuales');
  }
  profile.maintenanceItems.forEach((item, index) => {
    // La base exige un intervalo positivo en todo mantenimiento, este habilitado o no.
    require(`costProfile.maintenanceItems[${index}].intervalKm`, item.intervalKm, 'Debe ser mayor que cero');
  });

  const rateSum = [
    profile.platformCommissionRate,
    profile.paymentPercentageRate,
    profile.targetProfitMargin,
  ].reduce((sum, rate) => sum.add(Fraction.parse(rate)), Fraction.ZERO);
  if (rateSum.compare(MAX_RATE_SUM) >= 0) {
    errors.push({
      field: 'costProfile.targetProfitMargin',
      code: 'rateSum',
      message: 'Las comisiones mas el margen deben sumar menos de 0.90',
    });
  }
  return errors;
}

/** Decimal de la base como texto canonico: sin ceros de relleno ni notacion exponencial. */
const decimal = (value: { toFixed(): string }): string => value.toFixed();
const optionalDecimal = (value: { toFixed(): string } | null): string | null =>
  value === null ? null : decimal(value);

export function toVehicleDto(vehicle: VehicleWithProfile): VehicleDto {
  const profile = vehicle.vehicleCostProfiles.find((candidate) => candidate.isActive);
  if (!profile) {
    throw new Error(`El vehiculo ${vehicle.id} no tiene perfil de costos activo`);
  }
  return {
    id: vehicle.id,
    type: vehicle.type,
    ...(vehicle.brand === null ? {} : { brand: vehicle.brand }),
    ...(vehicle.model === null ? {} : { model: vehicle.model }),
    ...(vehicle.year === null ? {} : { year: vehicle.year }),
    fuelType: vehicle.fuelType,
    fuelEfficiencyKmPerGallon: decimal(vehicle.fuelEfficiencyKmPerGallon),
    isDefault: vehicle.isDefault,
    currentValue: decimal(vehicle.currentValue),
    expectedResidualValue: decimal(vehicle.expectedResidualValue),
    remainingUsefulLifeKm: optionalDecimal(vehicle.remainingUsefulLifeKm),
    costProfile: {
      fuelPricePerGallon: decimal(profile.fuelPricePerGallon),
      tireSetCost: decimal(profile.tireSetCost),
      tireUsefulLifeKm: optionalDecimal(profile.tireUsefulLifeKm),
      monthlyFixedCost: decimal(profile.monthlyFixedCost),
      expectedMonthlyKm: optionalDecimal(profile.expectedMonthlyKm),
      targetHourlyIncome: decimal(profile.targetHourlyIncome),
      platformCommissionRate: decimal(profile.platformCommissionRate),
      paymentPercentageRate: decimal(profile.paymentPercentageRate),
      paymentFixedFee: decimal(profile.paymentFixedFee),
      targetProfitMargin: decimal(profile.targetProfitMargin),
      maintenanceItems: [...profile.maintenanceItems]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((item) => ({
          name: item.name,
          cost: decimal(item.cost),
          intervalKm: decimal(item.intervalKm),
          enabled: item.enabled,
        })),
    },
  };
}
