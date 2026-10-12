/** Fuente de tiempo inyectable: vencimientos y ventanas se prueban sin esperar. */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('CLOCK');

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
