export type UpstreamErrorKind = 'timeout' | 'network' | 'server' | 'invalid';

/** El servicio externo no respondio de forma utilizable tras agotar los reintentos. */
export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export interface UpstreamOptions {
  /** Limite por intento, no total. */
  timeoutMs: number;
  /** Reintentos ante timeout, error de red o 5xx. Un 4xx nunca se reintenta. */
  retries: number;
}

export interface UpstreamResponse {
  status: number;
  /** JSON ya leido; en respuestas no 2xx puede ser el texto tal cual. */
  body: unknown;
}

/**
 * Peticion HTTP a un servicio interno (rutas, direcciones) con timeout por intento y reintentos.
 * Devuelve cualquier respuesta 2xx o 4xx; lanza UpstreamError si no se obtuvo ninguna utilizable.
 */
export async function requestJson(
  url: string,
  init: RequestInit,
  options: UpstreamOptions,
): Promise<UpstreamResponse> {
  let lastError = new UpstreamError('network', `Sin respuesta de ${url}`);

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
      text = await response.text();
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'TimeoutError';
      lastError = new UpstreamError(
        isTimeout ? 'timeout' : 'network',
        isTimeout
          ? `Sin respuesta en ${options.timeoutMs} ms`
          : `Error de red: ${(error as Error).message}`,
      );
      continue;
    }

    if (response.status >= 500) {
      lastError = new UpstreamError('server', `Respondio ${response.status}`, response.status);
      continue;
    }

    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      if (response.ok) {
        throw new UpstreamError('invalid', 'La respuesta no es JSON', response.status);
      }
      return { status: response.status, body: text };
    }
  }

  throw lastError;
}
