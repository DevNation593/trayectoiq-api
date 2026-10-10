import { describe, expect, it } from 'vitest';
import { calculate } from '../../src/modules/pricing/domain/pricing-engine.js';
import { PRICING_ENGINE_VERSION } from '../../src/modules/pricing/domain/types.js';
import { golden } from '../support/pricing-fixtures.js';

/**
 * contract/fixtures/pricing-engine-golden.json: casos resueltos con aritmetica exacta por el
 * motor de referencia. La comparacion es por igualdad exacta de strings: raw a 10 decimales,
 * umbrales, decision y bloque `api` (03_PRICING_ENGINE.md secciones 2.2 y 16).
 */
describe('fixtures golden del Pricing Engine', () => {
  it('el archivo trae los 9 casos de la version que implementa el motor', () => {
    expect(golden.fixtures).toHaveLength(9);
    expect(golden.pricingEngineVersion).toBe(PRICING_ENGINE_VERSION);
  });

  it.each(golden.fixtures)('$name', ({ route, quote, vehicleCostProfile, expected }) => {
    const result = calculate({ route, quote, vehicleCostProfile }, golden.engineConfig);

    expect(result).toEqual({ pricingEngineVersion: golden.pricingEngineVersion, ...expected });
  });

  it('no modifica la entrada', () => {
    const { route, quote, vehicleCostProfile } = golden.fixtures[1]!;
    const input = structuredClone({ route, quote, vehicleCostProfile });
    calculate(input, golden.engineConfig);
    expect(input).toEqual({ route, quote, vehicleCostProfile });
  });

  it('es determinista: dos ejecuciones dan el mismo resultado', () => {
    const { route, quote, vehicleCostProfile } = golden.fixtures[8]!;
    const first = calculate({ route, quote, vehicleCostProfile }, golden.engineConfig);
    const second = calculate({ route, quote, vehicleCostProfile }, golden.engineConfig);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
