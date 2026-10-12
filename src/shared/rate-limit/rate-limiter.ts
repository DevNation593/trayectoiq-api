import type { Clock } from '../clock/clock.js';

export interface RatePolicy {
  limit: number;
  windowMs: number;
}

export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

interface Window {
  startedAt: number;
  windowMs: number;
  count: number;
}

/**
 * Limite de uso en memoria con ventana fija por clave: la ventana empieza con la primera peticion.
 * Vale mientras haya una sola instancia de API; con dos hace falta un almacen compartido (ADR-003).
 */
export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly clock: Clock) {}

  consume(key: string, policy: RatePolicy): RateDecision {
    const now = this.clock.now().getTime();
    let window = this.windows.get(key);
    if (!window || now - window.startedAt >= window.windowMs) {
      window = { startedAt: now, windowMs: policy.windowMs, count: 0 };
      this.windows.set(key, window);
    }
    if (window.count >= policy.limit) {
      const remainingMs = window.startedAt + window.windowMs - now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
    }
    window.count += 1;
    return { allowed: true };
  }

  /** Elimina las ventanas vencidas. Se llama periodicamente para acotar la memoria. */
  sweep(): void {
    const now = this.clock.now().getTime();
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= window.windowMs) this.windows.delete(key);
    }
  }

  get size(): number {
    return this.windows.size;
  }
}
