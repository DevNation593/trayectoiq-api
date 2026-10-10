import { describe, expect, it } from 'vitest';
import { Fraction, FractionError } from '../../src/shared/fraction/fraction.js';

const f = (value: string | number): Fraction => Fraction.parse(value);

describe('Fraction.parse', () => {
  it.each([
    ['2.75', 11n, 4n],
    ['0.10', 1n, 10n],
    ['-0.5', -1n, 2n],
    ['007.50', 15n, 2n],
    ['0', 0n, 1n],
    ['-0', 0n, 1n],
    ['0.000', 0n, 1n],
    ['110', 110n, 1n],
  ])('lee %s como fraccion reducida', (text, numerator, denominator) => {
    const value = f(text);
    expect(value.numerator).toBe(numerator);
    expect(value.denominator).toBe(denominator);
  });

  it('acepta enteros como number', () => {
    expect(f(10000).equals(f('10000'))).toBe(true);
    expect(f(-3).equals(f('-3'))).toBe(true);
  });

  it.each(['', ' 1', '1 ', '1.', '.5', '+1', '1e3', '1,5', 'abc', 'NaN', '--1', '1.2.3', '0x10'])(
    'rechaza el texto %j',
    (text) => {
      expect(() => f(text)).toThrow(FractionError);
    },
  );

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'rechaza el number %s (solo enteros seguros)',
    (value) => {
      expect(() => f(value)).toThrow(FractionError);
    },
  );

  it('rechaza valores que no son string ni number', () => {
    expect(() => f(null as unknown as string)).toThrow(FractionError);
    expect(() => f(undefined as unknown as string)).toThrow(FractionError);
  });
});

describe('Fraction.of', () => {
  it('reduce y deja el signo en el numerador', () => {
    const value = Fraction.of(2n, -4n);
    expect(value.numerator).toBe(-1n);
    expect(value.denominator).toBe(2n);
  });

  it('rechaza denominador cero', () => {
    expect(() => Fraction.of(1n, 0n)).toThrow(FractionError);
  });
});

describe('aritmetica exacta', () => {
  it('suma, resta, multiplica y divide sin perdida', () => {
    expect(Fraction.of(1n, 3n).add(Fraction.of(1n, 6n)).equals(Fraction.of(1n, 2n))).toBe(true);
    expect(f('0.3').sub(f('0.1')).equals(f('0.2'))).toBe(true);
    expect(f('0.1').mul(f('0.2')).equals(f('0.02'))).toBe(true);
    expect(f('1').div(f('3')).equals(Fraction.of(1n, 3n))).toBe(true);
  });

  it('17 / 110 × 2.75 es exactamente 0.425 (el caso que rompe a los decimales de precision fija)', () => {
    expect(f('17').div(f('110')).mul(f('2.75')).equals(f('0.425'))).toBe(true);
  });

  it('0.1 + 0.2 es exactamente 0.3', () => {
    expect(f('0.1').add(f('0.2')).equals(f('0.3'))).toBe(true);
  });

  it('dividir por cero lanza', () => {
    expect(() => f('1').div(f('0'))).toThrow(FractionError);
  });

  it('no pierde exactitud con magnitudes enormes', () => {
    const big = f('123456789012345678901234567890.123456789');
    expect(big.add(f('0.000000001')).sub(big).equals(f('0.000000001'))).toBe(true);
  });
});

describe('comparacion', () => {
  it('compare devuelve -1, 0 o 1', () => {
    expect(f('3.74').compare(f('3.75'))).toBe(-1);
    expect(f('3.750').compare(f('3.75'))).toBe(0);
    expect(f('3.76').compare(f('3.75'))).toBe(1);
    expect(f('-1').compare(f('-2'))).toBe(1);
  });

  it('signo', () => {
    expect(f('-0.01').sign()).toBe(-1);
    expect(f('0').sign()).toBe(0);
    expect(f('-0').sign()).toBe(0);
    expect(f('0.01').sign()).toBe(1);
  });

  it('max devuelve el mayor', () => {
    expect(Fraction.max(f('0'), f('-5')).equals(f('0'))).toBe(true);
    expect(Fraction.max(f('2'), f('7')).equals(f('7'))).toBe(true);
  });
});

describe('ceilToStep', () => {
  const tiny = Fraction.of(1n, 10n ** 30n);

  it('sube al siguiente multiplo del paso', () => {
    expect(f('3.7414814815').ceilToStep(f('0.01')).equals(f('3.75'))).toBe(true);
    expect(f('4.2091666667').ceilToStep(f('0.05')).equals(f('4.25'))).toBe(true);
  });

  it('un valor exactamente sobre el paso no sube', () => {
    expect(f('3.75').ceilToStep(f('0.05')).equals(f('3.75'))).toBe(true);
    expect(f('3').ceilToStep(f('0.01')).equals(f('3'))).toBe(true);
  });

  it('un valor infinitesimalmente por encima del paso sube un paso completo', () => {
    expect(f('3.75').add(tiny).ceilToStep(f('0.05')).equals(f('3.80'))).toBe(true);
  });

  it('un valor infinitesimalmente por debajo del paso queda en el paso', () => {
    expect(f('3.75').sub(tiny).ceilToStep(f('0.05')).equals(f('3.75'))).toBe(true);
  });

  it('cero queda en cero y los negativos suben hacia cero', () => {
    expect(f('0').ceilToStep(f('0.01')).equals(f('0'))).toBe(true);
    expect(f('-0.004').ceilToStep(f('0.01')).equals(f('0'))).toBe(true);
    expect(f('-0.016').ceilToStep(f('0.01')).equals(f('-0.01'))).toBe(true);
  });

  it.each(['0', '-0.01'])('rechaza el paso %s', (step) => {
    expect(() => f('1').ceilToStep(f(step))).toThrow(FractionError);
  });
});

describe('toFixedHalfUp', () => {
  it.each([
    ['1.005', 2, '1.01'], // con float, 1.005.toFixed(2) da '1.00'
    ['1.004999', 2, '1.00'],
    ['0.125', 2, '0.13'],
    ['2.5', 0, '3'],
    ['12', 2, '12.00'],
    ['0', 2, '0.00'],
    ['0.425', 10, '0.4250000000'],
  ])('%s a %i decimales es %s', (text, places, expected) => {
    expect(f(text).toFixedHalfUp(places)).toBe(expected);
  });

  it('los empates negativos se alejan de cero', () => {
    expect(f('-2.5').toFixedHalfUp(0)).toBe('-3');
    expect(f('-0.125').toFixedHalfUp(2)).toBe('-0.13');
    expect(f('-0.4346666667').toFixedHalfUp(2)).toBe('-0.43');
  });

  it('nunca produce cero negativo', () => {
    expect(f('-0.004').toFixedHalfUp(2)).toBe('0.00');
    expect(f('-0.4').toFixedHalfUp(0)).toBe('0');
  });

  it('redondea fracciones periodicas', () => {
    expect(Fraction.of(1n, 3n).toFixedHalfUp(10)).toBe('0.3333333333');
    expect(Fraction.of(2n, 3n).toFixedHalfUp(10)).toBe('0.6666666667');
  });

  it('funciona mas alla de la precision de number', () => {
    expect(f('123456789012345678901234567890.5').toFixedHalfUp(0)).toBe(
      '123456789012345678901234567891',
    );
  });

  it.each([-1, 1.5, Number.NaN])('rechaza %s decimales', (places) => {
    expect(() => f('1').toFixedHalfUp(places)).toThrow(FractionError);
  });
});
