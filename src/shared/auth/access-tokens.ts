import { Inject, Injectable } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { CLOCK, type Clock } from '../clock/clock.js';
import { AppError } from '../errors/app-error.js';

export interface AccessClaims {
  userId: string;
  sessionId: string;
}

const ISSUER = 'trayectoiq-api';
const AUDIENCE = 'trayectoiq-app';

/** 06_SECURITY_PRIVACY.md seccion 2: access token de 10 a 15 minutos. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export const sessionExpired = (): AppError =>
  new AppError(401, 'AUTH_TOKEN_EXPIRED', 'La sesion no es valida o ya vencio');

/** Access tokens JWT (HS256). Solo identifican usuario y sesion; el resto se lee de la base. */
@Injectable()
export class AccessTokens {
  private readonly key: Uint8Array;

  constructor(
    @Inject(APP_ENV) env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.key = new TextEncoder().encode(env.jwtAccessSecret);
  }

  async sign(claims: AccessClaims): Promise<string> {
    const issuedAt = Math.floor(this.clock.now().getTime() / 1000);
    return new SignJWT({ sid: claims.sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
      .sign(this.key);
  }

  /** Lanza AUTH_TOKEN_EXPIRED si el token esta vencido, alterado o no es de esta API. */
  async verify(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
        currentDate: this.clock.now(),
      });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        throw sessionExpired();
      }
      return { userId: payload.sub, sessionId: payload.sid };
    } catch {
      throw sessionExpired();
    }
  }
}
