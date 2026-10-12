import { createHash } from 'node:crypto';
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { catchError, defer, from, mergeMap, type Observable, of, throwError } from 'rxjs';
import { CLOCK, type Clock } from '../clock/clock.js';
import { OPERATION } from '../contract/contract.guard.js';
import { Contract } from '../contract/contract.js';
import { DatabaseService } from '../database/database.service.js';
import { AppError } from '../errors/app-error.js';

/** Las claves expiran a las 24 horas (DEVELOPMENT_GUIDE.md, Idempotencia). */
const KEY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Una peticion que quedo "en curso" mas de este tiempo se da por interrumpida (el proceso murio
 * antes de guardar la respuesta) y la siguiente con la misma clave puede volver a ejecutarla.
 */
const STALE_IN_PROGRESS_MS = 60_000;

const HTTP_CODE_METADATA = '__httpCode__';

type Claim = { kind: 'execute'; id: string } | { kind: 'replay'; status: number; body: unknown };

interface StoredKey {
  id: string;
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
  created_at: Date;
}

const keyReused = (detail: string): AppError =>
  new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'La clave de idempotencia ya se uso', { detail });

/** JSON con las claves ordenadas, para que el mismo cuerpo de siempre la misma huella. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Idempotencia para toda operacion cuyo contrato declare la cabecera Idempotency-Key:
 * la misma clave con la misma peticion devuelve la respuesta guardada sin volver a ejecutar;
 * con una peticion distinta responde 409. Solo se guardan respuestas correctas: tras un error,
 * el reintento vuelve a ejecutar.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(Contract) private readonly contract: Contract,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const handler = context.getHandler();
    const operationId = this.reflector.get<string | undefined>(OPERATION, handler);
    if (!operationId || !this.contract.requiresIdempotencyKey(operationId)) {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    // ContractGuard ya comprobo que la cabecera existe y tiene la forma declarada.
    const key = String(request.headers['idempotency-key']);
    const userId = request.auth?.userId ?? null;
    const requestHash = createHash('sha256')
      .update(stableStringify([request.method, request.url.split('?')[0], request.body ?? null]))
      .digest('hex');
    const successStatus =
      this.reflector.get<number | undefined>(HTTP_CODE_METADATA, handler) ??
      (request.method === 'POST' ? 201 : 200);

    return defer(() => from(this.claim(userId, operationId, key, requestHash))).pipe(
      mergeMap((claim) => {
        if (claim.kind === 'replay') {
          void reply.status(claim.status).header('idempotent-replayed', 'true');
          return of(claim.body);
        }
        return next.handle().pipe(
          mergeMap(async (body: unknown) => {
            await this.complete(claim.id, successStatus, body);
            return body;
          }),
          catchError((error: unknown) =>
            from(this.release(claim.id)).pipe(mergeMap(() => throwError(() => error))),
          ),
        );
      }),
    );
  }

  private async claim(
    userId: string | null,
    scope: string,
    key: string,
    requestHash: string,
  ): Promise<Claim> {
    const db = this.database.client;
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + KEY_TTL_MS);

    await db.$executeRaw`
      DELETE FROM idempotency_keys
      WHERE scope = ${scope} AND idempotency_key = ${key}
        AND user_id IS NOT DISTINCT FROM ${userId}::uuid AND expires_at <= ${now}`;

    // El indice unico (NULLS NOT DISTINCT) decide quien llego primero, tambien entre peticiones simultaneas.
    const inserted = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO idempotency_keys (user_id, scope, idempotency_key, request_hash, expires_at, created_at)
      VALUES (${userId}::uuid, ${scope}, ${key}, ${requestHash}, ${expiresAt}, ${now})
      ON CONFLICT DO NOTHING
      RETURNING id`;
    if (inserted[0]) {
      return { kind: 'execute', id: inserted[0].id };
    }

    const [existing] = await db.$queryRaw<StoredKey[]>`
      SELECT id, request_hash, response_status, response_body, created_at
      FROM idempotency_keys
      WHERE scope = ${scope} AND idempotency_key = ${key}
        AND user_id IS NOT DISTINCT FROM ${userId}::uuid`;
    if (!existing) {
      // La otra peticion fallo y libero la clave justo ahora: que el cliente reintente.
      throw keyReused('Hay otra peticion con la misma clave en curso; reintenta.');
    }
    if (existing.request_hash !== requestHash) {
      throw keyReused('La clave ya se uso con una peticion distinta.');
    }
    if (existing.response_status !== null) {
      return { kind: 'replay', status: existing.response_status, body: existing.response_body };
    }

    if (now.getTime() - existing.created_at.getTime() > STALE_IN_PROGRESS_MS) {
      const taken = await db.$queryRaw<{ id: string }[]>`
        UPDATE idempotency_keys SET created_at = ${now}, expires_at = ${expiresAt}
        WHERE id = ${existing.id}::uuid AND response_status IS NULL AND created_at = ${existing.created_at}
        RETURNING id`;
      if (taken[0]) {
        return { kind: 'execute', id: taken[0].id };
      }
    }
    throw keyReused('Hay otra peticion con la misma clave en curso; reintenta.');
  }

  private async complete(id: string, status: number, body: unknown): Promise<void> {
    const stored = JSON.stringify(body ?? null);
    await this.database.client.$executeRaw`
      UPDATE idempotency_keys SET response_status = ${status}, response_body = ${stored}::jsonb
      WHERE id = ${id}::uuid`;
  }

  private async release(id: string): Promise<void> {
    await this.database.client.$executeRaw`DELETE FROM idempotency_keys WHERE id = ${id}::uuid`;
  }
}
