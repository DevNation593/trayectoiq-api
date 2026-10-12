import { Inject, Injectable } from '@nestjs/common';
import { errors, jwtVerify, SignJWT } from 'jose';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { CLOCK, type Clock } from '../clock/clock.js';

/** `route`: metricas de una ruta ya calculada. `preview`: todo lo necesario para guardar una cotizacion. */
export type TokenKind = 'route' | 'preview';

export class TokenError extends Error {
  constructor(readonly reason: 'expired' | 'invalid') {
    super(reason === 'expired' ? 'El token ya vencio' : 'El token no es valido');
    this.name = 'TokenError';
  }
}

const ISSUER = 'trayectoiq-api';

/**
 * Tokens firmados (JWS HS256) que la API entrega al cliente para no guardar previews en el servidor
 * (04_ARCHITECTURE.md seccion 3). Van firmados, no cifrados: su contenido son datos del propio
 * usuario. Cada token queda atado a un usuario y a un proposito.
 */
@Injectable()
export class SignedTokens {
  private readonly key: Uint8Array;

  constructor(
    @Inject(APP_ENV) env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.key = new TextEncoder().encode(env.previewTokenSecret);
  }

  sign(kind: TokenKind, userId: string, payload: object, expiresAt: Date): Promise<string> {
    return new SignJWT({ data: payload })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience(`tiq:${kind}`)
      .setSubject(userId)
      .setIssuedAt(Math.floor(this.clock.now().getTime() / 1000))
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.key);
  }

  /** Lanza TokenError('expired') si vencio y TokenError('invalid') en cualquier otro caso. */
  async verify<T>(
    kind: TokenKind,
    token: string,
    userId: string,
  ): Promise<{ payload: T; expiresAt: Date }> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: `tiq:${kind}`,
        subject: userId,
        currentDate: this.clock.now(),
      });
      if (typeof payload.exp !== 'number' || typeof payload.data !== 'object' || !payload.data) {
        throw new TokenError('invalid');
      }
      return { payload: payload.data as T, expiresAt: new Date(payload.exp * 1000) };
    } catch (error) {
      if (error instanceof TokenError) throw error;
      throw new TokenError(error instanceof errors.JWTExpired ? 'expired' : 'invalid');
    }
  }
}
