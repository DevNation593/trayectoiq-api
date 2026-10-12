import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors/app-error.js';
import { RateLimiter, type RatePolicy } from './rate-limiter.js';

type RateKey = 'ip' | 'email' | 'user';

interface RateRule extends RatePolicy {
  by: RateKey;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Limites iniciales de 06_SECURITY_PRIVACY.md seccion 4. Una operacion puede tener varias reglas;
 * se aplican todas. "email" es el correo del cuerpo o, con sesion, el del usuario.
 */
export const RATE_POLICIES = {
  login: [
    { by: 'ip', limit: 5, windowMs: MINUTE },
    { by: 'email', limit: 5, windowMs: MINUTE },
  ],
  register: [{ by: 'ip', limit: 3, windowMs: HOUR }],
  emailCode: [{ by: 'email', limit: 3, windowMs: HOUR }],
  autocomplete: [{ by: 'user', limit: 60, windowMs: MINUTE }],
  preview: [{ by: 'user', limit: 20, windowMs: MINUTE }],
  events: [{ by: 'ip', limit: 10, windowMs: MINUTE }],
  default: [{ by: 'user', limit: 120, windowMs: MINUTE }],
} as const satisfies Record<string, readonly RateRule[]>;

export type RatePolicyName = keyof typeof RATE_POLICIES;

const RATE_LIMIT = 'tiq:rateLimit';

/** Elige la politica de limite de una operacion. Sin decorador se aplica "default". */
export const RateLimit = (policy: RatePolicyName): MethodDecorator =>
  SetMetadata(RATE_LIMIT, policy);

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const policy =
      this.reflector.get<RatePolicyName | undefined>(RATE_LIMIT, context.getHandler()) ?? 'default';
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    for (const rule of RATE_POLICIES[policy]) {
      const subject = this.subject(rule.by, request);
      if (subject === undefined) continue;
      const decision = this.limiter.consume(`${policy}:${rule.by}:${subject}`, rule);
      if (!decision.allowed) {
        throw new AppError(429, 'RATE_LIMITED', 'Demasiadas peticiones; intenta mas tarde', {
          headers: { 'retry-after': String(decision.retryAfterSeconds) },
        });
      }
    }
    return true;
  }

  private subject(by: RateKey, request: FastifyRequest): string | undefined {
    if (by === 'ip') {
      return request.ip;
    }
    if (by === 'user') {
      // Sin sesion (rutas publicas) el limite por usuario cae sobre la IP.
      return request.auth?.userId ?? request.ip;
    }
    const email = (request.body as { email?: unknown } | null | undefined)?.email;
    const value = typeof email === 'string' ? email : request.auth?.email;
    return value?.trim().toLowerCase() || undefined;
  }
}
