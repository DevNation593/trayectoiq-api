import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { CLOCK, type Clock } from '../../shared/clock/clock.js';
import { AppError } from '../../shared/errors/app-error.js';

export type OidcProvider = 'GOOGLE' | 'APPLE';

/** Lo unico que se toma de un token de identidad, ya verificado. */
export interface OidcProfile {
  subject: string;
  email: string | null;
  emailVerified: boolean;
}

/** De donde salen las claves publicas de cada proveedor. En tests se sustituye por un juego local. */
export const OIDC_KEY_SETS = Symbol('OIDC_KEY_SETS');
export type OidcKeySets = Record<OidcProvider, JWTVerifyGetKey>;

export const remoteKeySets = (): OidcKeySets => ({
  GOOGLE: createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')),
  APPLE: createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys')),
});

const ISSUERS: Record<OidcProvider, string[]> = {
  GOOGLE: ['https://accounts.google.com', 'accounts.google.com'],
  APPLE: ['https://appleid.apple.com'],
};

const rejected = (): AppError =>
  new AppError(401, 'AUTH_INVALID_CREDENTIALS', 'No se pudo validar la identidad con el proveedor');

/**
 * Verifica en el servidor un token de identidad de Google o Apple: firma contra las claves del
 * proveedor, emisor, audiencia, vencimiento y nonce (06_SECURITY_PRIVACY.md seccion 2).
 * Nunca se confia en un correo ni en un sujeto enviados aparte por el cliente.
 */
@Injectable()
export class OidcVerifier {
  private readonly audiences: Record<OidcProvider, string[]>;

  constructor(
    @Inject(OIDC_KEY_SETS) private readonly keySets: OidcKeySets,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_ENV) env: Env,
  ) {
    this.audiences = {
      GOOGLE: env.googleOauthClientIds,
      APPLE: env.appleSigninAudience ? [env.appleSigninAudience] : [],
    };
  }

  async verify(provider: OidcProvider, token: string, nonce: string): Promise<OidcProfile> {
    const audience = this.audiences[provider];
    if (audience.length === 0) {
      // Proveedor sin configurar: no hay audiencia valida contra la cual aceptar un token.
      throw rejected();
    }

    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.keySets[provider], {
        algorithms: ['RS256', 'ES256'],
        issuer: ISSUERS[provider],
        audience,
        currentDate: this.clock.now(),
      }));
    } catch {
      throw rejected();
    }

    // Google devuelve el nonce tal cual; Sign in with Apple nativo devuelve su SHA-256.
    const hashedNonce = createHash('sha256').update(nonce).digest('hex');
    if (payload.nonce !== nonce && payload.nonce !== hashedNonce) {
      throw rejected();
    }
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      throw rejected();
    }
    return {
      subject: payload.sub,
      email: typeof payload.email === 'string' && payload.email !== '' ? payload.email : null,
      // Apple lo envia como texto en algunos flujos.
      emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    };
  }
}
