import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { call, type CallResult, type Session } from './api.js';
import { fixture } from './pricing-fixtures.js';
import type { TestApp } from './test-app.js';

export interface VehicleBody {
  type: 'MOTORCYCLE' | 'CAR';
  brand?: string;
  model?: string;
  year?: number;
  fuelType: 'GASOLINE' | 'DIESEL' | 'HYBRID';
  fuelEfficiencyKmPerGallon: string;
  isDefault?: boolean;
  currentValue: string;
  expectedResidualValue: string;
  remainingUsefulLifeKm: string | null;
  costProfile: {
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
    maintenanceItems: { name: string; cost: string; intervalKm: string; enabled: boolean }[];
  };
}

export type VehicleResponse = VehicleBody & { id: string };

/** El cuerpo de la API equivalente al perfil de costos de un fixture del Pricing Engine. */
export function vehicleFromFixture(
  name = 'A_moto_10km_negotiate',
  type: VehicleBody['type'] = name.startsWith('C_') || name.startsWith('I_') ? 'CAR' : 'MOTORCYCLE',
): VehicleBody {
  const profile = structuredClone(fixture(name).vehicleCostProfile);
  return {
    type,
    fuelType: 'GASOLINE',
    fuelEfficiencyKmPerGallon: profile.fuelEfficiencyKmPerGallon ?? '0',
    currentValue: profile.currentVehicleValue,
    expectedResidualValue: profile.expectedResidualValue,
    remainingUsefulLifeKm: profile.remainingUsefulLifeKm,
    costProfile: {
      fuelPricePerGallon: profile.fuelPricePerGallon,
      tireSetCost: profile.tireSetCost,
      tireUsefulLifeKm: profile.tireUsefulLifeKm,
      monthlyFixedCost: profile.monthlyFixedCost,
      expectedMonthlyKm: profile.expectedMonthlyKm,
      targetHourlyIncome: profile.targetHourlyIncome,
      platformCommissionRate: profile.platformCommissionRate,
      paymentPercentageRate: profile.paymentPercentageRate,
      paymentFixedFee: profile.paymentFixedFee,
      targetProfitMargin: profile.targetProfitMargin,
      maintenanceItems: profile.maintenanceItems,
    },
  };
}

export const idempotencyKey = (): Record<string, string> => ({
  'idempotency-key': `test-${randomUUID()}`,
});

export function postVehicle(
  test: TestApp,
  session: Session,
  body: unknown = vehicleFromFixture(),
  headers: Record<string, string> = idempotencyKey(),
): Promise<CallResult<VehicleResponse>> {
  return call<VehicleResponse>(test, 'createVehicle', {
    token: session.accessToken,
    body,
    headers,
  });
}

export async function createVehicle(
  test: TestApp,
  session: Session,
  body: VehicleBody = vehicleFromFixture(),
): Promise<VehicleResponse> {
  const created = await postVehicle(test, session, body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body;
}
