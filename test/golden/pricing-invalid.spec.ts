import { describe, expect, it } from 'vitest';
import { PricingError } from '../../src/modules/pricing/domain/errors.js';
import { calculate } from '../../src/modules/pricing/domain/pricing-engine.js';
import { golden, inputOf, invalid, setPath } from '../support/pricing-fixtures.js';

/**
 * contract/fixtures/pricing-engine-invalid.json: cada caso aplica sus overrides sobre el
 * fixture base y debe fallar con el codigo indicado (03_PRICING_ENGINE.md seccion 14).
 */
describe('entradas invalidas del Pricing Engine', () => {
  it('el archivo trae los 16 casos', () => {
    expect(invalid.invalidFixtures).toHaveLength(16);
  });

  it('el fixture base, sin overrides, es valido', () => {
    expect(() => calculate(inputOf(invalid.baseFixture), golden.engineConfig)).not.toThrow();
  });

  it.each(invalid.invalidFixtures)('$name -> $expectedCode', ({ overrides, expectedCode }) => {
    const input = inputOf(invalid.baseFixture);
    for (const [path, value] of Object.entries(overrides)) {
      setPath(input, path, value);
    }

    let thrown: unknown;
    try {
      calculate(input, golden.engineConfig);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PricingError);
    expect((thrown as PricingError).code).toBe(expectedCode);
  });
});
