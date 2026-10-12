// Metricas de validacion (08_ANALYTICS_VALIDATION.md seccion 4) sobre un periodo.
//
//   pnpm metrics --from 2026-10-01 --to 2026-11-01 [--json]
//
// Las fechas son UTC; --from es inclusive y --to exclusive. Lee DATABASE_URL del entorno o de .env.
// Cada proporcion sale con numerador, denominador e intervalo de Wilson del 95%; las consultas
// estan en scripts/metrics/*.sql y solo leen.
//
// Codigos de salida: 0 correcto, 64 uso incorrecto.
import { parseArgs } from 'node:util';
import pg from 'pg';
import { runMetrics } from './metrics/run-metrics.js';

function usage(message: string): never {
  process.stderr.write(
    `${message}\nUso: pnpm metrics --from AAAA-MM-DD --to AAAA-MM-DD [--json]\n`,
  );
  process.exit(64);
}

const { values: args } = parseArgs({
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});

const day = (name: 'from' | 'to'): Date => {
  const value = args[name];
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    usage(`Falta --${name} o no tiene la forma AAAA-MM-DD.`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    usage(`--${name} no es una fecha valida.`);
  }
  return date;
};
const period = { from: day('from'), to: day('to') };
if (period.to.getTime() <= period.from.getTime()) {
  usage('--to debe ser posterior a --from.');
}

if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile('.env');
  } catch {
    // Sin .env: se informa abajo si falta la variable.
  }
}
if (!process.env.DATABASE_URL) {
  usage('Falta DATABASE_URL.');
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const metrics = await runMetrics(pool, period);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
  } else {
    for (const { metric, ...columns } of Object.values(metrics)) {
      const detail = Object.entries(columns)
        .map(([name, value]) => `${name}=${value ?? 'sin datos'}`)
        .join('  ');
      process.stdout.write(`${metric.padEnd(36)} ${detail}\n`);
    }
  }
} finally {
  await pool.end();
}
