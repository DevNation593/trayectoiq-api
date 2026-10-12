import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, toProblem } from './app-error.js';

/** Errores del framework o del servidor HTTP que no pasaron por AppError, por estado. */
const BY_STATUS: Record<number, { code: string; title: string }> = {
  400: { code: 'VALIDATION_FAILED', title: 'La peticion no es valida' },
  401: { code: 'AUTH_TOKEN_EXPIRED', title: 'Se requiere iniciar sesion' },
  403: { code: 'FORBIDDEN', title: 'No tienes permiso para esta operacion' },
  404: { code: 'NOT_FOUND', title: 'El recurso no existe' },
  413: { code: 'VALIDATION_FAILED', title: 'La peticion es demasiado grande' },
  415: { code: 'VALIDATION_FAILED', title: 'Formato de contenido no soportado' },
  429: { code: 'RATE_LIMITED', title: 'Demasiadas peticiones' },
};

const INTERNAL = new AppError(500, 'INTERNAL_ERROR', 'Error interno');

/**
 * Unico punto donde un error se convierte en respuesta: siempre application/problem+json con
 * un code del catalogo y el traceId de la peticion. Nada de lo que no sea AppError llega al cliente.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const error = this.normalize(exception);

    if (error.status >= 500) {
      const where = {
        traceId: request.id,
        method: request.method,
        path: request.url.split('?')[0],
      };
      if (exception instanceof AppError) {
        // Un 5xx declarado (por ejemplo, un proveedor caido): se anota, sin traza de pila.
        this.logger.warn({ ...where, code: exception.code });
      } else {
        // Inesperado: el detalle queda en el log, enlazado por traceId; al cliente solo le llega el codigo.
        this.logger.error(where, exception instanceof Error ? exception.stack : String(exception));
      }
    }

    for (const [name, value] of Object.entries(error.options.headers ?? {})) {
      void reply.header(name, value);
    }
    void reply
      .status(error.status)
      .type('application/problem+json')
      .send(toProblem(error, request.id));
  }

  private normalize(exception: unknown): AppError {
    if (exception instanceof AppError) {
      return exception;
    }
    // HttpException de Nest (ruta inexistente, etc.) y errores de Fastify (JSON mal formado,
    // cuerpo demasiado grande): ambos traen un estado 4xx que se puede devolver sin exponer nada.
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : (exception as { statusCode?: unknown } | null)?.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const known = BY_STATUS[status] ?? {
        code: 'VALIDATION_FAILED',
        title: 'La peticion no es valida',
      };
      return new AppError(status, known.code, known.title);
    }
    return INTERNAL;
  }
}
