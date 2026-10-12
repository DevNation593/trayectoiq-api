import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { CLOCK, type Clock } from '../clock/clock.js';
import { DatabaseService } from '../database/database.service.js';
import { AppError } from '../errors/app-error.js';
import { AccessTokens, sessionExpired } from './access-tokens.js';
import { IS_PUBLIC } from './public.decorator.js';

const sessionRevoked = (): AppError =>
  new AppError(401, 'AUTH_SESSION_REVOKED', 'La sesion fue cerrada');

export const accountSuspended = (): AppError =>
  new AppError(403, 'ACCOUNT_SUSPENDED', 'La cuenta esta suspendida');

/**
 * Guard global: toda ruta exige bearer salvo las marcadas con @Public().
 * Ademas de verificar la firma, consulta la sesion y el usuario en cada peticion, para que
 * cerrar sesion, suspender o eliminar una cuenta surta efecto de inmediato y no al vencer el token.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AccessTokens) private readonly tokens: AccessTokens,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? '');
    if (!match?.[1]) {
      throw sessionExpired();
    }
    const claims = await this.tokens.verify(match[1]);

    const session = await this.database.client.authSession.findUnique({
      where: { id: claims.sessionId },
      include: { user: true },
    });
    if (!session || session.userId !== claims.userId) {
      throw sessionExpired();
    }
    if (session.revokedAt || session.user.deletedAt || session.user.status === 'DELETED') {
      throw sessionRevoked();
    }
    if (session.expiresAt.getTime() <= this.clock.now().getTime()) {
      throw sessionExpired();
    }
    if (session.user.status !== 'ACTIVE') {
      throw accountSuspended();
    }

    request.auth = {
      userId: session.user.id,
      sessionId: session.id,
      role: session.user.role,
      email: session.user.email,
      emailVerified: session.user.emailVerifiedAt !== null,
    };
    return true;
  }
}
