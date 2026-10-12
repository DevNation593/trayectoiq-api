import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Fila que devuelve cada consulta: `metric` mas sus columnas (proporcion con intervalo, o distribucion). */
export type MetricRow = { metric: string } & Record<string, string | number | null>;

export interface MetricPeriod {
  /** Inicio, inclusive. */
  from: Date;
  /** Fin, exclusive. */
  to: Date;
}

/** Lo minimo que hace falta de un cliente o un pool de pg. */
interface Queryable {
  query(text: string, values: unknown[]): Promise<{ rows: unknown[] }>;
}

const DIRECTORY = fileURLToPath(new URL('.', import.meta.url));

/** Nombre de cada metrica con su SQL: un archivo .sql por metrica en esta carpeta. */
export function metricQueries(): Map<string, string> {
  return new Map(
    readdirSync(DIRECTORY)
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .map((file) => [file.replace(/\.sql$/, ''), readFileSync(`${DIRECTORY}/${file}`, 'utf8')]),
  );
}

/** Ejecuta todas las metricas de 08_ANALYTICS_VALIDATION.md seccion 4 sobre un periodo. */
export async function runMetrics(
  database: Queryable,
  period: MetricPeriod,
): Promise<Record<string, MetricRow>> {
  const results: Record<string, MetricRow> = {};
  for (const [name, sql] of metricQueries()) {
    const { rows } = await database.query(sql, [period.from, period.to]);
    const row = rows[0] as MetricRow | undefined;
    if (!row) {
      throw new Error(`La metrica ${name} no devolvio ninguna fila`);
    }
    results[name] = row;
  }
  return results;
}
