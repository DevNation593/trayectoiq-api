import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import type { User } from '../../generated/prisma/client.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AccessTokens,
  sessionExpired,
} from '../../shared/auth/access-tokens.js';
import { accountSuspended } from '../../shared/auth/auth.guard.js';
import { hmacHex, randomToken } from '../../shared/auth/secrets.js';
import { CLOCK, type Clock } from '../../shared/clock/clock.js';
import { DatabaseService } from '../../shared/database/database.service.js';
import { AppError } from '../../shared/errors/app-error.js';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export interface DeviceInfo {
  deviceLabel?: string;
  platform?: 'IOS' | 'ANDROID';
  appVersion?: string;
}

export type RevokeReason = 'LOGOUT' | 'LOGOUT_ALL' | 'REUSE_DETECTED' | 'PASSWORD_RESET';

/** Una sesion sin uso vence a los 60 dias; cada rotacion la renueva. */
const SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Ventana en la que presentar el refresh token anterior se trata como un reintento (la respuesta
 * de la rotacion se perdio en la red) y no como un robo. 06_SECURITY_PRIVACY.md seccion 2.
 */
const REUSE_GRACE_MS = 10_000;

const invalidRefreshToken = (): AppError =>
  new AppError(401, 'AUTH_INVALID_CREDENTIALS', 'Las credenciales no son validas');

@Injectable()
export class SessionsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccessTokens) private readonly accessTokens: AccessTokens,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  async create(userId: string, device: DeviceInfo = {}): Promise<SessionTokens> {
    const now = this.clock.now();
    const refreshToken = randomToken();
    const session = await this.database.client.authSession.create({
      data: {
        userId,
        refreshTokenHash: this.fingerprint(refreshToken),
        deviceLabel: device.deviceLabel?.slice(0, 100),
        platform: device.platform ?? 'UNKNOWN',
        appVersion: device.appVersion?.slice(0, 40),
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
        createdAt: now,
        lastUsedAt: now,
      },
    });
    return this.tokens(userId, session.id, refreshToken);
  }

  /** Cambia el refresh token por uno nuevo. Devuelve tambien el usuario, para la respuesta. */
  async rotate(refreshToken: string): Promise<{ tokens: SessionTokens; user: User }> {
    const presented = this.fingerprint(refreshToken);
    const now = this.clock.now();
    const session = await this.database.client.authSession.findFirst({
      where: { OR: [{ refreshTokenHash: presented }, { previousRefreshTokenHash: presented }] },
      include: { user: true },
    });

    if (!session) {
      throw invalidRefreshToken();
    }
    if (session.revokedAt || session.user.deletedAt || session.user.status === 'DELETED') {
      throw new AppError(401, 'AUTH_SESSION_REVOKED', 'La sesion fue cerrada');
    }
    if (session.expiresAt.getTime() <= now.getTime()) {
      throw sessionExpired();
    }
    if (session.user.status !== 'ACTIVE') {
      throw accountSuspended();
    }

    const isPreviousToken = session.previousRefreshTokenHash === presented;
    if (isPreviousToken) {
      const sinceRotation = now.getTime() - (session.rotatedAt?.getTime() ?? 0);
      if (sinceRotation > REUSE_GRACE_MS) {
        // El token ya se habia cambiado por otro: alguien mas lo tiene. Se cierra la sesion entera.
        await this.revoke(session.id, 'REUSE_DETECTED');
        throw new AppError(401, 'AUTH_SESSION_REVOKED', 'La sesion fue cerrada');
      }
    }

    const next = randomToken();
    // La condicion sobre el hash actual evita que dos rotaciones simultaneas ganen las dos.
    const updated = await this.database.client.authSession.updateMany({
      where: { id: session.id, refreshTokenHash: session.refreshTokenHash, revokedAt: null },
      data: {
        refreshTokenHash: this.fingerprint(next),
        // En un reintento se conserva el token anterior original y su hora, para no alargar la gracia.
        previousRefreshTokenHash: isPreviousToken ? presented : session.refreshTokenHash,
        rotatedAt: isPreviousToken ? session.rotatedAt : now,
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
        lastUsedAt: now,
      },
    });
    if (updated.count === 0) {
      throw invalidRefreshToken();
    }

    return { tokens: await this.tokens(session.userId, session.id, next), user: session.user };
  }

  async revoke(sessionId: string, reason: RevokeReason): Promise<void> {
    await this.database.client.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revokedReason: reason },
    });
  }

  async revokeAll(userId: string, reason: RevokeReason): Promise<void> {
    await this.database.client.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revokedReason: reason },
    });
  }

  private fingerprint(refreshToken: string): string {
    return hmacHex(this.env.jwtRefreshPepper, refreshToken);
  }

  private async tokens(
    userId: string,
    sessionId: string,
    refreshToken: string,
  ): Promise<SessionTokens> {
    return {
      accessToken: await this.accessTokens.sign({ userId, sessionId }),
      refreshToken,
      expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
    };
  }
}
