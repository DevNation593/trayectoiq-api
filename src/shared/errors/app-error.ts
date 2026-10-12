import type { FieldError } from '../contract/contract.js';

export interface AppErrorOptions {
  detail?: string;
  errors?: FieldError[];
  /** Cabeceras extra de la respuesta, por ejemplo Retry-After. */
  headers?: Record<string, string>;
}

/**
 * Error que la API devuelve tal cual al cliente como ProblemDetails. `code` sale del catalogo
 * de openapi.yaml; `title` es un texto corto y estable, apto para mostrar.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly options: AppErrorOptions = {},
  ) {
    super(title);
    this.name = 'AppError';
  }
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  traceId: string;
  detail?: string;
  errors?: FieldError[];
}

const PROBLEM_BASE_URL = 'https://api.trayectoiq.com/problems/';

export function toProblem(error: AppError, traceId: string): ProblemDetails {
  return {
    type: PROBLEM_BASE_URL + error.code.toLowerCase().replace(/_/g, '-'),
    title: error.title,
    status: error.status,
    code: error.code,
    traceId,
    ...(error.options.detail ? { detail: error.options.detail } : {}),
    ...(error.options.errors?.length ? { errors: error.options.errors } : {}),
  };
}
