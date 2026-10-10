import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PricingError } from '../../src/modules/pricing/domain/errors.js';
import { calculate } from '../../src/modules/pricing/domain/pricing-engine.js';
import {
  DEFAULT_ENGINE_CONFIG,
  type PricingInput,
  type PricingResult,
} from '../../src/modules/pricing/domain/types.js';
import { Fraction } from '../../src/shared/fraction/fraction.js';

/** Propiedades de 03_PRICING_ENGINE.md seccion 16, con 1000 casos generados cada una. */
const RUNS = { numRuns: 1000 };
const config = DEFAULT_ENGINE_CONFIG;
const f = (value: string): Fraction => Fraction.parse(value);

/** Decimal en texto entre min y max (en unidades enteras), con `places` decimales. */
const decimal = (min: number, max: number, places: number): fc.Arbitrary<string> => {
  const scale = 10n ** BigInt(places);
  return fc
    .bigInt({ min: BigInt(min) * scale, max: BigInt(max) * scale })
    .map((scaled) => Fraction.of(scaled, scale).toFixedHalfUp(places));
};

/** Decimal estrictamente positivo: divisores. */
const positive = (max: number, places: number): fc.Arbitrary<string> => {
  const scale = 10n ** BigInt(places);
  return fc
    .bigInt({ min: 1n, max: BigInt(max) * scale })
    .map((scaled) => Fraction.of(scaled, scale).toFixedHalfUp(places));
};

const validInput: fc.Arbitrary<PricingInput> = fc.record({
  route: fc.record({
    pickupDistanceMeters: fc.integer({ min: 0, max: 50_000 }),
    pickupDurationSeconds: fc.integer({ min: 0, max: 7_200 }),
    tripDistanceMeters: fc.integer({ min: 1, max: 200_000 }),
    tripDurationSeconds: fc.integer({ min: 1, max: 36_000 }),
  }),
  quote: fc.record({
    waitingSeconds: fc.integer({ min: 0, max: 10_800 }),
    emptyReturnProbability: decimal(0, 1, 2),
    tollsAmount: decimal(0, 50, 2),
    parkingAmount: decimal(0, 50, 2),
    otherDirectCostAmount: decimal(0, 50, 2),
    offeredPrice: fc.option(decimal(0, 500, 2), { nil: null }),
  }),
  vehicleCostProfile: fc.record({
    fuelEfficiencyKmPerGallon: positive(300, 1),
    fuelPricePerGallon: decimal(0, 10, 2),
    maintenanceItems: fc.array(
      fc.record({
        name: fc.constantFrom('Oil', 'Chain', 'Brakes', 'Filter'),
        cost: decimal(0, 500, 2),
        intervalKm: positive(100_000, 0),
        enabled: fc.boolean(),
      }),
      { maxLength: 5 },
    ),
    tireSetCost: decimal(0, 2_000, 2),
    tireUsefulLifeKm: positive(100_000, 0),
    currentVehicleValue: decimal(0, 50_000, 2),
    expectedResidualValue: decimal(0, 50_000, 2),
    remainingUsefulLifeKm: positive(300_000, 0),
    monthlyFixedCost: decimal(0, 1_000, 2),
    expectedMonthlyKm: positive(10_000, 0),
    targetHourlyIncome: decimal(0, 50, 2),
    // 0.40 + 0.10 + 0.39 = 0.89 < 0.90: la suma siempre es valida.
    platformCommissionRate: fc
      .integer({ min: 0, max: 4_000 })
      .map((n) => Fraction.of(BigInt(n), 10_000n).toFixedHalfUp(4)),
    paymentPercentageRate: fc
      .integer({ min: 0, max: 1_000 })
      .map((n) => Fraction.of(BigInt(n), 10_000n).toFixedHalfUp(4)),
    paymentFixedFee: decimal(0, 2, 2),
    targetProfitMargin: fc
      .integer({ min: 0, max: 3_900 })
      .map((n) => Fraction.of(BigInt(n), 10_000n).toFixedHalfUp(4)),
  }),
});

const gte = (a: string, b: string): boolean => f(a).compare(f(b)) >= 0;
const run = (input: PricingInput): PricingResult => calculate(input, config);
const withQuote = (input: PricingInput, quote: Partial<PricingInput['quote']>): PricingInput => ({
  ...input,
  quote: { ...input.quote, ...quote },
});

describe('propiedades del Pricing Engine', () => {
  it('recomendado >= minimo >= piso, en raw y en umbrales', () => {
    fc.assert(
      fc.property(validInput, (input) => {
        const { pricesRaw, thresholds } = run(input);
        expect(gte(pricesRaw.recommended, pricesRaw.minimum)).toBe(true);
        expect(gte(pricesRaw.minimum, pricesRaw.floor)).toBe(true);
        expect(gte(thresholds.recommended, thresholds.minimum)).toBe(true);
        expect(gte(thresholds.minimum, thresholds.floor)).toBe(true);
      }),
      RUNS,
    );
  });

  it('ningun umbral queda por debajo de su raw ni se aleja mas de un paso', () => {
    const steps = {
      floor: f(config.thresholdStep),
      minimum: f(config.thresholdStep),
      recommended: f(config.recommendedStep),
    };
    fc.assert(
      fc.property(validInput, (input) => {
        const { pricesRaw, thresholds } = run(input);
        for (const level of ['floor', 'minimum', 'recommended'] as const) {
          const distance = f(thresholds[level]).sub(f(pricesRaw[level]));
          expect(distance.sign(), level).toBeGreaterThanOrEqual(0);
          expect(distance.compare(steps[level]), level).toBeLessThanOrEqual(0);
        }
      }),
      RUNS,
    );
  });

  it('el recomendado siempre es multiplo de recommendedStep', () => {
    fc.assert(
      fc.property(validInput, (input) => {
        const multiples = f(run(input).thresholds.recommended).div(f(config.recommendedStep));
        expect(multiples.denominator).toBe(1n);
      }),
      RUNS,
    );
  });

  it('aumentar los peajes nunca reduce ningun precio', () => {
    fc.assert(
      fc.property(validInput, decimal(0, 50, 2), (input, extra) => {
        const before = run(input).pricesRaw;
        const tolls = f(input.quote.tollsAmount).add(f(extra)).toFixedHalfUp(2);
        const after = run(withQuote(input, { tollsAmount: tolls })).pricesRaw;
        expect(gte(after.floor, before.floor)).toBe(true);
        expect(gte(after.minimum, before.minimum)).toBe(true);
        expect(gte(after.recommended, before.recommended)).toBe(true);
      }),
      RUNS,
    );
  });

  it('aumentar la espera nunca reduce el minimo ni el recomendado', () => {
    fc.assert(
      fc.property(validInput, fc.integer({ min: 0, max: 10_800 }), (input, other) => {
        const [shorter, longer] = [input.quote.waitingSeconds, other].sort((a, b) => a - b);
        const before = run(withQuote(input, { waitingSeconds: shorter })).pricesRaw;
        const after = run(withQuote(input, { waitingSeconds: longer })).pricesRaw;
        expect(gte(after.minimum, before.minimum)).toBe(true);
        expect(gte(after.recommended, before.recommended)).toBe(true);
      }),
      RUNS,
    );
  });

  it('aumentar la probabilidad de regreso vacio nunca reduce costos ni tiempo', () => {
    fc.assert(
      fc.property(validInput, decimal(0, 1, 2), (input, other) => {
        const [lower, higher] = [input.quote.emptyReturnProbability, other].sort((a, b) =>
          f(a).compare(f(b)),
        );
        const before = run(withQuote(input, { emptyReturnProbability: lower }));
        const after = run(withQuote(input, { emptyReturnProbability: higher }));
        expect(gte(after.costsRaw.operating, before.costsRaw.operating)).toBe(true);
        expect(gte(after.costsRaw.targetCompensation, before.costsRaw.targetCompensation)).toBe(
          true,
        );
        expect(gte(after.effectiveHoursRaw, before.effectiveHoursRaw)).toBe(true);
      }),
      RUNS,
    );
  });

  it('una oferta igual o mayor al recomendado siempre es ACCEPT', () => {
    fc.assert(
      fc.property(validInput, decimal(0, 100, 2), (input, extra) => {
        const recommended = run(input).thresholds.recommended;
        const offer = f(recommended).add(f(extra)).toFixedHalfUp(2);
        expect(run(withQuote(input, { offeredPrice: offer })).decision).toBe('ACCEPT');
      }),
      RUNS,
    );
  });

  it('una oferta menor al minimo siempre es REJECT', () => {
    fc.assert(
      fc.property(validInput, fc.integer({ min: 1, max: 10_000 }), (input, cents) => {
        const minimum = f(run(input).thresholds.minimum);
        const offer = minimum.sub(Fraction.of(BigInt(cents), 100n));
        fc.pre(offer.sign() >= 0);
        const result = run(withQuote(input, { offeredPrice: offer.toFixedHalfUp(2) }));
        expect(result.decision).toBe('REJECT');
      }),
      RUNS,
    );
  });

  it('la decision coincide siempre con los umbrales que ve el usuario', () => {
    fc.assert(
      fc.property(validInput, decimal(0, 500, 2), (input, offer) => {
        const { thresholds, decision } = run(withQuote(input, { offeredPrice: offer }));
        const expected = gte(offer, thresholds.recommended)
          ? 'ACCEPT'
          : gte(offer, thresholds.minimum)
            ? 'NEGOTIATE'
            : 'REJECT';
        expect(decision).toBe(expected);
      }),
      RUNS,
    );
  });

  it('el orden de los mantenimientos no cambia ningun resultado', () => {
    fc.assert(
      fc.property(
        validInput.chain((input) =>
          fc
            .shuffledSubarray(input.vehicleCostProfile.maintenanceItems, {
              minLength: input.vehicleCostProfile.maintenanceItems.length,
            })
            .map((shuffled) => ({ input, shuffled })),
        ),
        ({ input, shuffled }) => {
          const reordered = {
            ...input,
            vehicleCostProfile: { ...input.vehicleCostProfile, maintenanceItems: shuffled },
          };
          expect(run(reordered)).toEqual(run(input));
        },
      ),
      RUNS,
    );
  });

  it('la oferta no altera costos ni precios', () => {
    fc.assert(
      fc.property(validInput, (input) => {
        const withOffer = run(withQuote(input, { offeredPrice: '12.34' }));
        const without = run(withQuote(input, { offeredPrice: null }));
        expect(withOffer.costsRaw).toEqual(without.costsRaw);
        expect(withOffer.pricesRaw).toEqual(without.pricesRaw);
        expect(withOffer.thresholds).toEqual(without.thresholds);
      }),
      RUNS,
    );
  });

  it('los metros y segundos efectivos de la API distan menos de 1 de su valor raw', () => {
    fc.assert(
      fc.property(validInput, (input) => {
        const result = run(input);
        const meters = f(result.effectiveDistanceKmRaw).mul(f('1000'));
        const seconds = f(result.effectiveHoursRaw).mul(f('3600'));
        const one = Fraction.ONE;
        const off = (value: number, exact: Fraction): Fraction => {
          const difference = Fraction.parse(value).sub(exact);
          return difference.sign() < 0 ? Fraction.ZERO.sub(difference) : difference;
        };
        expect(off(result.api.effectiveDistanceMeters, meters).compare(one)).toBe(-1);
        expect(off(result.api.effectiveDurationSeconds, seconds).compare(one)).toBe(-1);
      }),
      RUNS,
    );
  });

  it('con valores bien formados pero arbitrarios, el unico error posible es PricingError', () => {
    const any = fc.oneof(decimal(-5, 5, 2), decimal(0, 1_000, 2), fc.constant('0'));
    const anyOrNull = fc.option(any, { nil: null });
    const arbitraryInput: fc.Arbitrary<PricingInput> = fc.record({
      route: fc.record({
        pickupDistanceMeters: fc.integer({ min: -10, max: 50_000 }),
        pickupDurationSeconds: fc.integer({ min: -10, max: 7_200 }),
        tripDistanceMeters: fc.integer({ min: -10, max: 200_000 }),
        tripDurationSeconds: fc.integer({ min: -10, max: 36_000 }),
      }),
      quote: fc.record({
        waitingSeconds: fc.integer({ min: -10, max: 20_000 }),
        emptyReturnProbability: decimal(-1, 2, 2),
        tollsAmount: any,
        parkingAmount: any,
        otherDirectCostAmount: any,
        offeredPrice: anyOrNull,
      }),
      vehicleCostProfile: fc.record({
        fuelEfficiencyKmPerGallon: anyOrNull,
        fuelPricePerGallon: any,
        maintenanceItems: fc.array(
          fc.record({
            name: fc.constant('Item'),
            cost: any,
            intervalKm: any,
            enabled: fc.boolean(),
          }),
          { maxLength: 3 },
        ),
        tireSetCost: any,
        tireUsefulLifeKm: anyOrNull,
        currentVehicleValue: any,
        expectedResidualValue: any,
        remainingUsefulLifeKm: anyOrNull,
        monthlyFixedCost: any,
        expectedMonthlyKm: anyOrNull,
        targetHourlyIncome: any,
        platformCommissionRate: decimal(-1, 2, 2),
        paymentPercentageRate: decimal(-1, 2, 2),
        paymentFixedFee: any,
        targetProfitMargin: decimal(-1, 2, 2),
      }),
    });
    fc.assert(
      fc.property(arbitraryInput, (input) => {
        try {
          const result = run(input);
          expect(result.pricingEngineVersion).toBe('1.0.0');
        } catch (error) {
          expect(error).toBeInstanceOf(PricingError);
        }
      }),
      { numRuns: 5000 },
    );
  });
});
