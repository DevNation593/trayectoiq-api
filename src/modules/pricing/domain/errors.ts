/** Codigos de 03_PRICING_ENGINE.md seccion 14; forman parte del catalogo de openapi.yaml. */
export type PricingErrorCode =
  | 'PRICING_INVALID_ROUTE'
  | 'PRICING_INVALID_PROBABILITY'
  | 'PRICING_NEGATIVE_AMOUNT'
  | 'PRICING_DIVISOR_ZERO'
  | 'PRICING_INVALID_RATE'
  | 'PRICING_INVALID_RATE_SUM';

/** La entrada tiene la forma correcta pero incumple una regla de dominio. La API responde 422. */
export class PricingError extends Error {
  constructor(
    readonly code: PricingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PricingError';
  }
}

/** La configuracion del motor es invalida. Es un error de despliegue, no del usuario. */
export class PricingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingConfigError';
  }
}
