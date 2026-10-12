import type { Clock } from '../../src/shared/clock/clock.js';

/** Reloj controlado por el test: el tiempo solo avanza cuando el test lo pide. */
export class FakeClock implements Clock {
  private current: number;

  constructor(start: Date = new Date('2026-10-12T15:00:00.000Z')) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}
