import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

export interface StubReply {
  status: number;
  /** Objeto (se envia como JSON) o texto tal cual. */
  body: unknown;
  /** Retraso antes de responder, para provocar timeouts. */
  delayMs?: number;
}

export interface StubRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

/**
 * Servidor HTTP local que reproduce respuestas grabadas. Los adaptadores se prueban contra el
 * con su cliente HTTP real: timeouts, reintentos y errores de red incluidos.
 */
export class StubServer {
  readonly requests: StubRequest[] = [];
  private readonly queue: StubReply[] = [];
  private fallback: StubReply = { status: 500, body: { error: 'sin respuesta programada' } };
  private server: Server | null = null;

  /** Encola respuestas: cada peticion consume la siguiente; al agotarse se repite la ultima. */
  reply(...replies: StubReply[]): this {
    this.queue.push(...replies);
    const last = replies.at(-1);
    if (last) this.fallback = last;
    return this;
  }

  reset(): void {
    this.requests.length = 0;
    this.queue.length = 0;
    this.fallback = { status: 500, body: { error: 'sin respuesta programada' } };
  }

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const url = new URL(request.url ?? '/', 'http://stub');
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text;
        try {
          body = text === '' ? null : JSON.parse(text);
        } catch {
          // Se conserva el texto tal cual.
        }
        this.requests.push({
          method: request.method ?? 'GET',
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          body,
        });
        const reply = this.queue.shift() ?? this.fallback;
        setTimeout(() => {
          const isText = typeof reply.body === 'string';
          response.writeHead(reply.status, {
            'content-type': isText ? 'text/plain' : 'application/json',
          });
          response.end(isText ? (reply.body as string) : JSON.stringify(reply.body));
        }, reply.delayMs ?? 0);
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

interface Recording {
  status: number;
  body: unknown;
}

/** Respuesta real grabada de Valhalla o Photon (test/fixtures/<proveedor>/<nombre>.json). */
export function recording(provider: 'valhalla' | 'photon', name: string): StubReply {
  const { status, body } = JSON.parse(
    readFileSync(`test/fixtures/${provider}/${name}.json`, 'utf8'),
  ) as Recording;
  return { status, body: structuredClone(body) };
}
