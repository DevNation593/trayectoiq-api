import { Fraction } from '../../../shared/fraction/fraction.js';
import { PricingError } from './errors.js';
import type { ParsedInput } from './parse-input.js';

const MAX_WAITING_SECONDS = Fraction.parse(10800);
const MAX_RATE_SUM = Fraction.parse('0.90');

const isPositive = (value: Fraction | null): boolean => value !== null && value.sign() > 0;
const isNegative = (value: Fraction): boolean => value.sign() < 0;

/**
 * Reglas de 03_PRICING_ENGINE.md seccion 14, en el orden de la tabla.
 * Lanza la primera que falle, para que el codigo devuelto sea determinista.
 */
export function validate(input: ParsedInput): void {
  // 1 a 3: ruta y espera.
  if (input.tripMeters.sign() <= 0 || input.tripSeconds.sign() <= 0) {
    throw new PricingError(
      'PRICING_INVALID_ROUTE',
      'La distancia y la duracion del trayecto deben ser mayores que cero',
    );
  }
  if (isNegative(input.pickupMeters) || isNegative(input.pickupSeconds)) {
    throw new PricingError('PRICING_INVALID_ROUTE', 'La recogida no puede ser negativa');
  }
  if (isNegative(input.waitingSeconds) || input.waitingSeconds.compare(MAX_WAITING_SECONDS) > 0) {
    throw new PricingError(
      'PRICING_INVALID_ROUTE',
      'La espera debe estar entre 0 y 10800 segundos',
    );
  }

  // 4: probabilidad de regreso vacio.
  if (isNegative(input.returnProbability) || input.returnProbability.compare(Fraction.ONE) > 0) {
    throw new PricingError(
      'PRICING_INVALID_PROBABILITY',
      'La probabilidad de regreso vacio debe estar entre 0 y 1',
    );
  }

  // 5: ningun monto negativo.
  const amounts = [
    input.tolls,
    input.parking,
    input.other,
    input.fuelPrice,
    input.tireSetCost,
    input.currentVehicleValue,
    input.expectedResidualValue,
    input.monthlyFixedCost,
    input.targetHourlyIncome,
    input.paymentFixedFee,
    ...input.maintenanceItems.map((item) => item.cost),
    ...(input.offer === null ? [] : [input.offer]),
  ];
  if (amounts.some(isNegative)) {
    throw new PricingError('PRICING_NEGATIVE_AMOUNT', 'Ningun monto puede ser negativo');
  }

  // 6 a 10: divisores. Un divisor ausente cuenta como cero.
  if (!isPositive(input.fuelEfficiency)) {
    throw new PricingError(
      'PRICING_DIVISOR_ZERO',
      'El rendimiento de combustible debe ser mayor que cero',
    );
  }
  if (input.maintenanceItems.some((item) => item.enabled && !isPositive(item.intervalKm))) {
    throw new PricingError(
      'PRICING_DIVISOR_ZERO',
      'El intervalo de cada mantenimiento habilitado debe ser mayor que cero',
    );
  }
  if (input.tireSetCost.sign() > 0 && !isPositive(input.tireUsefulLifeKm)) {
    throw new PricingError('PRICING_DIVISOR_ZERO', 'Falta la vida util de los neumaticos');
  }
  if (
    input.currentVehicleValue.compare(input.expectedResidualValue) > 0 &&
    !isPositive(input.remainingUsefulLifeKm)
  ) {
    throw new PricingError('PRICING_DIVISOR_ZERO', 'Falta la vida util restante del vehiculo');
  }
  if (input.monthlyFixedCost.sign() > 0 && !isPositive(input.expectedMonthlyKm)) {
    throw new PricingError('PRICING_DIVISOR_ZERO', 'Falta el kilometraje mensual esperado');
  }

  // 11 y 12: tasas.
  const rates = [
    input.platformCommissionRate,
    input.paymentPercentageRate,
    input.targetProfitMargin,
  ];
  if (rates.some((rate) => isNegative(rate) || rate.compare(Fraction.ONE) >= 0)) {
    throw new PricingError('PRICING_INVALID_RATE', 'Cada tasa debe estar en [0, 1)');
  }
  const rateSum = rates.reduce((sum, rate) => sum.add(rate), Fraction.ZERO);
  if (rateSum.compare(MAX_RATE_SUM) >= 0) {
    throw new PricingError(
      'PRICING_INVALID_RATE_SUM',
      'La suma de comisiones y margen debe ser menor que 0.90',
    );
  }
}
