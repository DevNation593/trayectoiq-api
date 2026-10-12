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
import { Contract } from './contract.js';

export const OPERATION = 'tiq:operation';

/**
 * Enlaza un handler con su operationId de openapi.yaml: la peticion se valida contra ese esquema
 * antes de llegar al handler, que puede confiar en la forma de lo que recibe.
 */
export const Operation = (operationId: string): MethodDecorator =>
  SetMetadata(OPERATION, operationId);

@Injectable()
export class ContractGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(Contract) private readonly contract: Contract,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const operationId = this.reflector.get<string | undefined>(OPERATION, context.getHandler());
    if (!operationId) {
      return true;
    }
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const errors = this.contract.validateRequest(operationId, {
      body: request.body,
      query: request.query as Record<string, unknown>,
      params: request.params as Record<string, unknown>,
      headers: request.headers,
    });
    if (errors.length > 0) {
      throw new AppError(422, 'VALIDATION_FAILED', 'La peticion no es valida', { errors });
    }
    return true;
  }
}
