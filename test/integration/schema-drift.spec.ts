import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedDatabase,
  createTempDatabase,
  type TempDatabase,
  withClient,
} from '../support/temp-database.js';

/**
 * contract/db/schema.sql es la referencia del modelo de datos (04_ARCHITECTURE.md seccion 6).
 * Este test aplica la referencia en una base y las migraciones de Prisma en otra, y exige
 * que los dos catalogos resultantes sean identicos.
 */

/** Todo lo que define el esquema, en forma comparable y ordenada. */
async function snapshot(database: string): Promise<Record<string, string[]>> {
  const queries: Record<string, string> = {
    extensions: `SELECT extname AS line FROM pg_extension WHERE extname <> 'plpgsql'`,
    enums: `
      SELECT t.typname || ': ' || string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) AS line
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' GROUP BY t.typname`,
    columns: `
      SELECT c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
             || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
             || COALESCE(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '') AS line
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid AND c.relkind = 'r'
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relname <> '_prisma_migrations'`,
    constraints: `
      SELECT c.relname || ' [' || con.contype::text || '] ' || pg_get_constraintdef(con.oid) AS line
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE c.relname <> '_prisma_migrations'`,
    indexes: `
      SELECT indexdef AS line FROM pg_indexes
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  };
  return withClient(database, async (client) => {
    const result: Record<string, string[]> = {};
    for (const [name, sql] of Object.entries(queries)) {
      const { rows } = await client.query<{ line: string }>(sql);
      result[name] = rows.map((row) => row.line).sort();
    }
    return result;
  });
}

describe('el esquema migrado coincide con contract/db/schema.sql', () => {
  let referenceDb: TempDatabase;
  let migratedDb: TempDatabase;
  let reference: Record<string, string[]>;
  let migrated: Record<string, string[]>;

  beforeAll(async () => {
    referenceDb = await createTempDatabase('schema_ref');
    const referenceSql = await readFile('contract/db/schema.sql', 'utf8');
    await withClient(referenceDb.name, (client) => client.query(referenceSql));

    migratedDb = await createMigratedDatabase('schema_mig');

    reference = await snapshot(referenceDb.name);
    migrated = await snapshot(migratedDb.name);
  });

  afterAll(async () => {
    await referenceDb?.drop();
    await migratedDb?.drop();
  });

  it('la referencia crea las 21 tablas del modelo', () => {
    const tables = new Set(reference.columns?.map((line) => line.split('.')[0]));
    expect(tables.size).toBe(21);
  });

  it.each(['extensions', 'enums', 'columns', 'constraints', 'indexes'])(
    '%s identicos',
    (section) => {
      expect(migrated[section]).toEqual(reference[section]);
    },
  );
});
