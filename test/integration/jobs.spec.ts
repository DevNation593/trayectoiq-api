import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { Mailer } from '../../src/modules/jobs/mailer.js';
import { PgBossJobQueue } from '../../src/modules/jobs/pg-boss-job-queue.js';
import { SmtpEmailSender } from '../../src/shared/email/smtp-email-sender.js';
import { createTempDatabase, type TempDatabase } from '../support/temp-database.js';

/**
 * La cola real (pg-boss sobre PostgreSQL) y el envio real por SMTP contra Mailpit.
 * Necesita `docker compose up -d postgres mailpit`.
 */

const mailpitUrl = process.env.MAILPIT_URL ?? 'http://localhost:8025';

async function waitFor<T>(
  probe: () => T | Promise<T>,
  description: string,
  timeoutMs = 20_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Se agoto la espera: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe('cola de trabajos sobre PostgreSQL', () => {
  let database: TempDatabase;
  let queue: PgBossJobQueue;
  const flakyAttempts = new Map<string, number>();
  const brokenAttempts = new Map<string, number>();
  const done: string[] = [];

  beforeAll(async () => {
    database = await createTempDatabase('jobs');
    const env = loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: database.url });
    queue = new PgBossJobQueue(env);

    queue.register<{ id: string }>(
      'test.flaky',
      ({ id }) => {
        const attempt = (flakyAttempts.get(id) ?? 0) + 1;
        flakyAttempts.set(id, attempt);
        if (attempt < 3) return Promise.reject(new Error(`fallo simulado ${attempt}`));
        done.push(id);
        return Promise.resolve();
      },
      { retryLimit: 3, retryDelaySeconds: 0 },
    );
    queue.register<{ id: string }>(
      'test.broken',
      ({ id }) => {
        brokenAttempts.set(id, (brokenAttempts.get(id) ?? 0) + 1);
        return Promise.reject(new Error('siempre falla'));
      },
      { retryLimit: 2, retryDelaySeconds: 0 },
    );
    new Mailer(queue, new SmtpEmailSender(env.smtpUrl, env.emailFrom));

    await queue.onApplicationBootstrap();
  });

  afterAll(async () => {
    await queue?.onModuleDestroy();
    await database?.drop();
  });

  it('un trabajo que falla se reintenta y termina', async () => {
    const id = randomUUID();
    await queue.enqueue('test.flaky', { id });

    await waitFor(() => done.includes(id), 'el trabajo deberia terminar al tercer intento');
    expect(flakyAttempts.get(id)).toBe(3);
  });

  it('un trabajo que siempre falla deja de intentarse al agotar sus reintentos', async () => {
    const id = randomUUID();
    await queue.enqueue('test.broken', { id });

    await waitFor(() => brokenAttempts.get(id) === 3, 'deberia intentarse 1 + 2 veces');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(brokenAttempts.get(id)).toBe(3);
  });

  it('encolar no espera al trabajo: resuelve antes de que el handler termine', async () => {
    const id = randomUUID();
    await queue.enqueue('test.flaky', { id });
    expect(done).not.toContain(id);
    await waitFor(() => done.includes(id), 'el trabajo termina despues, en segundo plano');
  });

  it('no se puede registrar un trabajo con la cola ya arrancada', () => {
    expect(() => queue.register('test.late', () => Promise.resolve())).toThrow(
      /despues de arrancar/,
    );
  });

  it('el correo encolado llega por SMTP y aparece en Mailpit', async () => {
    const marker = randomUUID();
    const mailer = new MailerProbe(queue);
    await mailer.send({
      to: 'conductor@example.com',
      subject: `Prueba de integracion ${marker}`,
      text: `Tu codigo de verificacion de TrayectoIQ es 123456.\n\nMarca: ${marker}`,
    });

    const message = await waitFor(async () => {
      const response = await fetch(
        `${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`subject:"${marker}"`)}`,
      );
      const { messages } = (await response.json()) as { messages: MailpitSummary[] };
      return messages[0];
    }, 'el correo deberia aparecer en Mailpit');

    expect(message.To[0]?.Address).toBe('conductor@example.com');
    expect(message.From.Address).toBe('no-reply@trayectoiq.local');

    const detail = (await (await fetch(`${mailpitUrl}/api/v1/message/${message.ID}`)).json()) as {
      Text: string;
    };
    expect(detail.Text).toContain('123456');
    expect(detail.Text).toContain(marker);
  });
});

interface MailpitSummary {
  ID: string;
  To: { Address: string }[];
  From: { Address: string };
}

/** Encola por el mismo nombre de trabajo que usa Mailer, sin volver a registrar el handler. */
class MailerProbe {
  constructor(private readonly queue: PgBossJobQueue) {}

  send(message: { to: string; subject: string; text: string }): Promise<void> {
    return this.queue.enqueue('email.send', message);
  }
}
