export interface JobOptions {
  /** Reintentos despues del primer intento. Por defecto 5. */
  retryLimit?: number;
  /** Espera inicial entre reintentos; crece de forma exponencial. Por defecto 2 s. */
  retryDelaySeconds?: number;
}

export type JobHandler<T> = (payload: T) => Promise<void>;

/**
 * Cola de trabajos en segundo plano (04_ARCHITECTURE.md seccion 5). Los handlers deben ser
 * idempotentes: un trabajo puede ejecutarse mas de una vez.
 */
export interface JobQueue {
  /** Declara el handler de un tipo de trabajo. Se llama una vez, al construir quien lo procesa. */
  register<T extends object>(name: string, handler: JobHandler<T>, options?: JobOptions): void;
  /** Encola un trabajo. Resuelve cuando quedo aceptado, no cuando termino. */
  enqueue<T extends object>(name: string, payload: T): Promise<void>;
}

export const JOB_QUEUE = Symbol('JOB_QUEUE');

export const DEFAULT_RETRY_LIMIT = 5;
export const DEFAULT_RETRY_DELAY_SECONDS = 2;
