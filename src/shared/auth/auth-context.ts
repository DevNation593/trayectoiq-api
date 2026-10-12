import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { sessionExpired } from './access-tokens.js';

/** Quien hace la peticion, ya comprobado contra la base por AuthGuard. */
export interface AuthContext {
  userId: string;
  sessionId: string;
  role: 'USER' | 'SUPPORT' | 'ADMIN';
  email: string;
  emailVerified: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/** Inyecta el AuthContext en un handler protegido. */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext => {
    const { auth } = context.switchToHttp().getRequest<FastifyRequest>();
    if (!auth) {
      // Solo puede pasar si se usa en una ruta @Public: es un error de programacion, no del cliente.
      throw sessionExpired();
    }
    return auth;
  },
);
