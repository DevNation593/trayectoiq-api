import { describe, expect, it } from 'vitest';
import { PricingConfigError, PricingError } from '../../src/modules/pricing/domain/errors.js';
import { calculate } from '../../src/modules/pricing/domain/pricing-engine.js';
import {
  DEFAULT_ENGINE_CONFIG,
  type PricingInput,
} from '../../src/modules/pricing/domain/types.js';
import { FractionError } from '../../src/shared/fraction/fraction.js';
import { golden, inputOf } from '../support/pricing-fixtures.js';

/** Fixture A: moto, 10 km, 30 min. Umbrales 1.25 / 3.75 / 4.25. */
const base = (): PricingInput => inputOf('A_moto_10km_negotiate');
const config = golden.engineConfig;

const codeOf = (input: PricingInput): string => {
  try {
    calculate(input, config);
  } catch (error) {
    if (error instanceof PricingError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};

describe('configuracion del motor', () => {
  it('la configuracion por defecto es la de Ecuador v1', () => {
    expect(DEFAULT_ENGINE_CONFIG).toEqual(config);
  });

  it('el paso del recomendado cambia solo el umbral recomendado', () => {
    const result = calculate(base(), { ...config, recommendedStep: '0.10' });
    expect(result.thresholds).toEqual({ floor: '1.25', minimum: '3.75', recommended: '4.30' });
    expect(result.pricesRaw.recommended).toBe('4.2091666667');
  });

  it.each(['0', '-0.05'])('rechaza recommendedStep=%s', (step) => {
    expect(() => calculate(base(), { ...config, recommendedStep: step })).toThrow(
      PricingConfigError,
    );
  });

  it('rechaza thresholdStep=0', () => {
    expect(() => calculate(base(), { ...config, thresholdStep: '0' })).toThrow(PricingConfigError);
  });

  it('rechaza un modo de regreso desconocido', () => {
    const unknown = { ...config, returnMode: 'ROUTED' as 'SYMMETRIC_ESTIMATE' };
    expect(() => calculate(base(), unknown)).toThrow(PricingConfigError);
  });
});

describe('orden de las validaciones: se reporta la primera regla incumplida', () => {
  it('ruta antes que montos', () => {
    const input = base();
    input.route.tripDistanceMeters = 0;
    input.quote.tollsAmount = '-1';
    expect(codeOf(input)).toBe('PRICING_INVALID_ROUTE');
  });

  it('probabilidad antes que montos', () => {
    const input = base();
    input.quote.emptyReturnProbability = '-0.1';
    input.quote.tollsAmount = '-1';
    expect(codeOf(input)).toBe('PRICING_INVALID_PROBABILITY');
  });

  it('montos antes que divisores', () => {
    const input = base();
    input.quote.parkingAmount = '-0.01';
    input.vehicleCostProfile.fuelEfficiencyKmPerGallon = '0';
    expect(codeOf(input)).toBe('PRICING_NEGATIVE_AMOUNT');
  });

  it('divisores antes que tasas', () => {
    const input = base();
    input.vehicleCostProfile.expectedMonthlyKm = '0';
    input.vehicleCostProfile.platformCommissionRate = '1';
    expect(codeOf(input)).toBe('PRICING_DIVISOR_ZERO');
  });

  it('tasa individual antes que la suma', () => {
    const input = base();
    input.vehicleCostProfile.targetProfitMargin = '1.5';
    expect(codeOf(input)).toBe('PRICING_INVALID_RATE');
  });
});

describe('limites de las reglas', () => {
  it.each(['0', '1', '0.5'])('acepta probabilidad de regreso %s', (probability) => {
    const input = base();
    input.quote.emptyReturnProbability = probability;
    expect(codeOf(input)).toBe('NO_ERROR');
  });

  it('acepta 10800 segundos de espera y rechaza una espera negativa', () => {
    const input = base();
    input.quote.waitingSeconds = 10800;
    expect(codeOf(input)).toBe('NO_ERROR');
    input.quote.waitingSeconds = -1;
    expect(codeOf(input)).toBe('PRICING_INVALID_ROUTE');
  });

  it('acepta comisiones mas margen en 0.8999 y rechaza 0.90', () => {
    const input = base();
    input.vehicleCostProfile.platformCommissionRate = '0.5';
    input.vehicleCostProfile.targetProfitMargin = '0.3999';
    expect(codeOf(input)).toBe('NO_ERROR');
    input.vehicleCostProfile.targetProfitMargin = '0.4';
    expect(codeOf(input)).toBe('PRICING_INVALID_RATE_SUM');
  });

  it('una tasa negativa es invalida', () => {
    const input = base();
    input.vehicleCostProfile.paymentPercentageRate = '-0.01';
    expect(codeOf(input)).toBe('PRICING_INVALID_RATE');
  });

  it('un divisor negativo cuenta como ausente', () => {
    const input = base();
    input.vehicleCostProfile.tireUsefulLifeKm = '-30000';
    expect(codeOf(input)).toBe('PRICING_DIVISOR_ZERO');
  });

  it('rechaza metros o segundos que no caben en un entero de 32 bits (columnas int de quotes)', () => {
    for (const field of [
      'tripDistanceMeters',
      'tripDurationSeconds',
      'pickupDistanceMeters',
      'pickupDurationSeconds',
    ] as const) {
      const input = base();
      input.route[field] = 2_147_483_648;
      expect(codeOf(input), field).toBe('PRICING_INVALID_ROUTE');
    }
  });

  it('acepta el maximo entero de 32 bits y devuelve enteros exactos', () => {
    const input = base();
    input.route.tripDistanceMeters = 2_147_483_647;
    input.route.pickupDistanceMeters = 2_147_483_647;
    input.quote.emptyReturnProbability = '1';
    const result = calculate(input, config);
    expect(result.api.effectiveDistanceMeters).toBe(3 * 2_147_483_647);
    expect(result.effectiveDistanceKmRaw).toBe('6442450.9410000000');
  });
});

describe('divisores opcionales', () => {
  it('un mantenimiento deshabilitado con intervalo cero se ignora', () => {
    const withDisabled = base();
    withDisabled.vehicleCostProfile.maintenanceItems.push({
      name: 'Deshabilitado',
      cost: '999',
      intervalKm: '0',
      enabled: false,
    });
    expect(calculate(withDisabled, config)).toEqual(calculate(base(), config));
  });

  it('un mantenimiento deshabilitado con costo negativo sigue siendo un monto negativo', () => {
    const input = base();
    input.vehicleCostProfile.maintenanceItems.push({
      name: 'Deshabilitado',
      cost: '-1',
      intervalKm: '1000',
      enabled: false,
    });
    expect(codeOf(input)).toBe('PRICING_NEGATIVE_AMOUNT');
  });

  it('sin costo de neumaticos, depreciacion ni fijos, los divisores pueden faltar', () => {
    const input = base();
    Object.assign(input.vehicleCostProfile, {
      tireSetCost: '0',
      tireUsefulLifeKm: null,
      currentVehicleValue: '800',
      expectedResidualValue: '800',
      remainingUsefulLifeKm: null,
      monthlyFixedCost: '0',
      expectedMonthlyKm: null,
    });
    const result = calculate(input, config);
    expect(result.costsRaw.tires).toBe('0.0000000000');
    expect(result.costsRaw.depreciation).toBe('0.0000000000');
    expect(result.costsRaw.fixed).toBe('0.0000000000');
  });

  it('un valor residual mayor que el valor actual no genera depreciacion negativa', () => {
    const input = base();
    input.vehicleCostProfile.currentVehicleValue = '500';
    input.vehicleCostProfile.expectedResidualValue = '800';
    input.vehicleCostProfile.remainingUsefulLifeKm = null;
    expect(calculate(input, config).costsRaw.depreciation).toBe('0.0000000000');
  });
});

describe('oferta', () => {
  const decisionFor = (offer: string | null): string | null => {
    const input = base();
    input.quote.offeredPrice = offer;
    return calculate(input, config).decision;
  };

  it('compara la oferta de forma exacta, con los decimales que traiga', () => {
    expect(decisionFor('3.749')).toBe('REJECT');
    expect(decisionFor('3.7500')).toBe('NEGOTIATE');
    expect(decisionFor('4.2499')).toBe('NEGOTIATE');
    expect(decisionFor('4.25')).toBe('ACCEPT');
  });

  it('una oferta de cero es valida y se rechaza', () => {
    expect(decisionFor('0')).toBe('REJECT');
    expect(decisionFor('-0')).toBe('REJECT');
  });

  it('sin oferta no hay decision ni ganancias', () => {
    const input = base();
    input.quote.offeredPrice = null;
    const result = calculate(input, config);
    expect(result.decision).toBeNull();
    expect(result.earningsPerHourRaw).toBeNull();
    expect(result.api.earningsPerHour).toBeNull();
    expect(result.api.earningsPerKm).toBeNull();
  });

  it('una ganancia negativa diminuta se muestra como 0.00, nunca como -0.00', () => {
    const input = base();
    // Ganancia = 0.9 × oferta - 1.117333...; con 1.2414 queda en -0.00007.
    input.quote.offeredPrice = '1.2414';
    const result = calculate(input, config);
    expect(result.earningsPerHourRaw?.startsWith('-')).toBe(true);
    expect(result.api.earningsPerHour).toBe('0.00');
    expect(result.api.earningsPerKm).toBe('0.00');
  });
});

describe('entradas mal formadas (las debe frenar el esquema de la API)', () => {
  it('un decimal que no es decimal lanza FractionError en vez de calcular', () => {
    const input = base();
    input.quote.tollsAmount = 'abc';
    expect(() => calculate(input, config)).toThrow(FractionError);
  });

  it('metros con parte fraccionaria lanzan FractionError', () => {
    const input = base();
    input.route.tripDistanceMeters = 10000.5;
    expect(() => calculate(input, config)).toThrow(FractionError);
  });

  it('un number donde se espera un decimal en texto no pasa por float', () => {
    const input = base();
    (input.quote as unknown as Record<string, unknown>).tollsAmount = 0.1;
    expect(() => calculate(input, config)).toThrow(FractionError);
  });
});
