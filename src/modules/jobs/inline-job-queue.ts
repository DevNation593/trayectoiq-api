import {
  DEFAULT_RETRY_LIMIT,
  type JobHandler,
  type JobOptions,
  type JobQueue,
} from './job-queue.js';

interface Registration {
  handler: JobHandler<object>;
  retryLimit: number;
}

/**
 * Cola que ejecuta cada trabajo en el momento de encolarlo, con los mismos reintentos pero sin
 * esperas. Es para tests: el resultado de un trabajo se puede observar justo despues de la llamada
 * que lo encolo. La cola real (PgBossJobQueue) tiene sus propios tests de integracion.
 */
export class InlineJobQueue implements JobQueue {
  private readonly registrations = new Map<string, Registration>();
  /** Trabajos que agotaron sus reintentos. */
  readonly failed: { name: string; payload: object; error: unknown }[] = [];

  register<T extends object>(name: string, handler: JobHandler<T>, options: JobOptions = {}): void {
    this.registrations.set(name, {
      handler: handler as JobHandler<object>,
      retryLimit: options.retryLimit ?? DEFAULT_RETRY_LIMIT,
    });
  }

  async enqueue<T extends object>(name: string, payload: T): Promise<void> {
    const registration = this.registrations.get(name);
    if (!registration) {
      throw new Error(`No hay handler registrado para el trabajo "${name}"`);
    }
    let lastError: unknown;
    for (let attempt = 0; attempt <= registration.retryLimit; attempt += 1) {
      try {
        await registration.handler(payload);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    // Igual que en la cola real, que un trabajo falle no hace fallar a quien lo encolo.
    this.failed.push({ name, payload, error: lastError });
  }
}
