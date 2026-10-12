import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/shared/rate-limit/rate-limiter.js';
import { FakeClock } from '../support/fake-clock.js';

const policy = { limit: 3, windowMs: 60_000 };

describe('RateLimiter', () => {
  it('permite hasta el limite dentro de la ventana y despues niega', () => {
    const limiter = new RateLimiter(new FakeClock());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(limiter.consume('login:ip:1.1.1.1', policy)).toEqual({ allowed: true });
    }
    expect(limiter.consume('login:ip:1.1.1.1', policy)).toMatchObject({ allowed: false });
  });

  it('al negar indica cuantos segundos faltan para poder reintentar', () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter(clock);
    for (let attempt = 0; attempt < 3; attempt += 1) limiter.consume('k', policy);
    clock.advance(20_500);
    expect(limiter.consume('k', policy)).toEqual({ allowed: false, retryAfterSeconds: 40 });
    clock.advance(39_400);
    expect(limiter.consume('k', policy)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('al terminar la ventana vuelve a permitir', () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter(clock);
    for (let attempt = 0; attempt < 4; attempt += 1) limiter.consume('k', policy);
    clock.advance(60_000);
    expect(limiter.consume('k', policy)).toEqual({ allowed: true });
  });

  it('cada clave tiene su propio contador', () => {
    const limiter = new RateLimiter(new FakeClock());
    for (let attempt = 0; attempt < 3; attempt += 1) limiter.consume('a', policy);
    expect(limiter.consume('a', policy).allowed).toBe(false);
    expect(limiter.consume('b', policy).allowed).toBe(true);
  });

  it('los intentos negados no alargan el bloqueo', () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter(clock);
    for (let attempt = 0; attempt < 3; attempt += 1) limiter.consume('k', policy);
    clock.advance(59_000);
    limiter.consume('k', policy);
    clock.advance(1_000);
    expect(limiter.consume('k', policy).allowed).toBe(true);
  });

  it('sweep descarta las ventanas vencidas para no acumular memoria', () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter(clock);
    limiter.consume('a', policy);
    clock.advance(30_000);
    limiter.consume('b', policy);
    clock.advance(30_000);
    limiter.sweep();
    expect(limiter.size).toBe(1);
  });
});
