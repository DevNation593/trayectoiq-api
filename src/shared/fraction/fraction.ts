export class FractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FractionError';
  }
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

/** Division entera redondeando hacia menos infinito. Requiere divisor positivo. */
function floorDiv(dividend: bigint, divisor: bigint): bigint {
  const quotient = dividend / divisor;
  return dividend % divisor !== 0n && dividend < 0n ? quotient - 1n : quotient;
}

/**
 * Numero racional exacto sobre BigInt: la aritmetica normativa del Pricing Engine
 * (03_PRICING_ENGINE.md seccion 2). Inmutable y siempre reducido, con denominador positivo.
 */
export class Fraction {
  static readonly ZERO = new Fraction(0n, 1n);
  static readonly ONE = new Fraction(1n, 1n);

  private constructor(
    readonly numerator: bigint,
    readonly denominator: bigint,
  ) {}

  static of(numerator: bigint, denominator: bigint = 1n): Fraction {
    if (denominator === 0n) {
      throw new FractionError('El denominador no puede ser cero');
    }
    const divisor = gcd(numerator, denominator);
    const sign = denominator < 0n ? -1n : 1n;
    return new Fraction((sign * numerator) / divisor, (sign * denominator) / divisor);
  }

  /**
   * Convierte un decimal en texto ("2.75", "-0.5") o un entero seguro en fraccion exacta.
   * No acepta exponentes, espacios, signo "+" ni numeros con parte fraccionaria:
   * un number no entero ya perdio exactitud antes de llegar aqui.
   */
  static parse(value: string | number): Fraction {
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) {
        throw new FractionError(`Solo se aceptan enteros seguros como number: ${value}`);
      }
      return new Fraction(BigInt(value), 1n);
    }
    if (typeof value !== 'string') {
      throw new FractionError(`Se esperaba un decimal en texto y llego ${typeof value}`);
    }
    const match = DECIMAL.exec(value);
    if (!match) {
      throw new FractionError(`No es un decimal valido: ${JSON.stringify(value)}`);
    }
    const [, sign, integer = '', fraction = ''] = match;
    const magnitude = BigInt(integer + fraction);
    return Fraction.of(sign === '-' ? -magnitude : magnitude, 10n ** BigInt(fraction.length));
  }

  static max(a: Fraction, b: Fraction): Fraction {
    return a.compare(b) >= 0 ? a : b;
  }

  add(other: Fraction): Fraction {
    return Fraction.of(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  sub(other: Fraction): Fraction {
    return Fraction.of(
      this.numerator * other.denominator - other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  mul(other: Fraction): Fraction {
    return Fraction.of(this.numerator * other.numerator, this.denominator * other.denominator);
  }

  div(other: Fraction): Fraction {
    if (other.numerator === 0n) {
      throw new FractionError('Division por cero');
    }
    return Fraction.of(this.numerator * other.denominator, this.denominator * other.numerator);
  }

  compare(other: Fraction): -1 | 0 | 1 {
    const difference = this.numerator * other.denominator - other.numerator * this.denominator;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }

  equals(other: Fraction): boolean {
    return this.numerator === other.numerator && this.denominator === other.denominator;
  }

  sign(): -1 | 0 | 1 {
    return this.numerator < 0n ? -1 : this.numerator > 0n ? 1 : 0;
  }

  /** Menor multiplo de `step` que es mayor o igual que este valor, calculado de forma exacta. */
  ceilToStep(step: Fraction): Fraction {
    if (step.sign() <= 0) {
      throw new FractionError('El paso de redondeo debe ser mayor que cero');
    }
    const ratio = this.div(step);
    const ceiling = -floorDiv(-ratio.numerator, ratio.denominator);
    return Fraction.of(ceiling).mul(step);
  }

  /** Texto con `places` decimales; los empates se alejan de cero. Nunca devuelve "-0". */
  toFixedHalfUp(places: number): string {
    if (!Number.isInteger(places) || places < 0) {
      throw new FractionError(`La cantidad de decimales debe ser un entero >= 0: ${places}`);
    }
    const scale = 10n ** BigInt(places);
    const magnitude = (this.numerator < 0n ? -this.numerator : this.numerator) * scale;
    const rounded = (2n * magnitude + this.denominator) / (2n * this.denominator);
    const sign = this.numerator < 0n && rounded !== 0n ? '-' : '';
    if (places === 0) {
      return `${sign}${rounded}`;
    }
    const digits = (rounded % scale).toString().padStart(places, '0');
    return `${sign}${rounded / scale}.${digits}`;
  }
}
