import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';

const run = promisify(execFile);

function baseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL es obligatoria para los tests de integracion');
  }
  return url;
}

export function urlFor(database: string): string {
  const url = new URL(baseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

export async function withClient<T>(
  database: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: urlFor(database) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export interface TempDatabase {
  name: string;
  url: string;
  drop: () => Promise<void>;
}

/** Crea una base vacia con nombre unico en el servidor de DATABASE_URL. */
export async function createTempDatabase(label: string): Promise<TempDatabase> {
  const name = `tiq_${label}_${randomBytes(4).toString('hex')}`;
  await withClient('postgres', (admin) => admin.query(`CREATE DATABASE ${name}`));
  return {
    name,
    url: urlFor(name),
    drop: async () => {
      await withClient('postgres', (admin) =>
        admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
      );
    },
  };
}

/** Aplica las migraciones por la misma via que el despliegue: la CLI de Prisma. */
export async function migrate(databaseUrl: string): Promise<void> {
  await run(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

export async function createMigratedDatabase(label: string): Promise<TempDatabase> {
  const database = await createTempDatabase(label);
  try {
    await migrate(database.url);
  } catch (error) {
    await database.drop();
    throw error;
  }
  return database;
}
