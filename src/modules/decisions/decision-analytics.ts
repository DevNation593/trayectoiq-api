import { Fraction } from '../../shared/fraction/fraction.js';

/** Limite inferior, en dolares, de cada tramo de precio final. Valores iniciales para Quito. */
const BANDS: readonly (readonly [lowerBound: string, band: string])[] = [
  ['20', 'GTE_20'],
  ['12', '12_TO_20'],
  ['8', '8_TO_12'],
  ['5', '5_TO_8'],
  ['3', '3_TO_5'],
];

/** Tramo del precio final para analytics: el evento no lleva el valor exacto. */
export function finalPriceBand(finalPrice: string): string {
  const price = Fraction.parse(finalPrice);
  const match = BANDS.find(([lowerBound]) => price.compare(Fraction.parse(lowerBound)) >= 0);
  return match ? match[1] : 'LT_3';
}

/**
 * Donde quedo la oferta inicial frente a los umbrales. Es otra lectura de la recomendacion, que ya
 * se calculo contra el minimo y el recomendado (03_PRICING_ENGINE.md seccion 9.3).
 */
export function initialOfferRelation(
  recommendation: 'ACCEPT' | 'NEGOTIATE' | 'REJECT' | null,
): 'NO_OFFER' | 'BELOW_MIN' | 'BETWEEN_MIN_REC' | 'AT_OR_ABOVE_REC' {
  switch (recommendation) {
    case 'ACCEPT':
      return 'AT_OR_ABOVE_REC';
    case 'NEGOTIATE':
      return 'BETWEEN_MIN_REC';
    case 'REJECT':
      return 'BELOW_MIN';
    default:
      return 'NO_OFFER';
  }
}
