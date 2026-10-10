// Calcula una cotizacion con el Pricing Engine desde un archivo JSON.
//
//   pnpm pricing:calc <archivo.json>
//
// El archivo tiene la forma de un fixture de contract/fixtures/pricing-engine-golden.json:
//   { "route": {...}, "quote": {...}, "vehicleCostProfile": {...}, "engineConfig": {...} }
// "engineConfig" es opcional (por defecto, Ecuador v1); "name" y "expected" se ignoran.
//
// Salida: el resultado como JSON en stdout.
// Codigos de salida: 0 calculado; 1 uso o archivo incorrecto; 2 la entrada incumple una regla.
import { readFileSync } from 'node:fs';
import { PricingError } from '../src/modules/pricing/domain/errors.js';
import { calculate } from '../src/modules/pricing/domain/pricing-engine.js';
import {
  DEFAULT_ENGINE_CONFIG,
  type EngineConfig,
  type PricingInput,
} from '../src/modules/pricing/domain/types.js';

const REQUIRED_SECTIONS = ['route', 'quote', 'vehicleCostProfile'] as const;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  fail('Uso: pnpm pricing:calc <archivo.json>');
}

let text: string;
try {
  text = readFileSync(file, 'utf8');
} catch (error) {
  fail(`No se pudo leer ${file}: ${(error as Error).message}`);
}

let data: unknown;
try {
  data = JSON.parse(text);
} catch (error) {
  fail(`No es JSON valido: ${file}: ${(error as Error).message}`);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

if (!isObject(data)) {
  fail('El archivo debe contener un objeto con route, quote y vehicleCostProfile');
}
const missing = REQUIRED_SECTIONS.filter((section) => !isObject(data[section]));
if (missing.length > 0) {
  fail(`Faltan secciones en el archivo: ${missing.join(', ')}`);
}

const input = {
  route: data.route,
  quote: data.quote,
  vehicleCostProfile: data.vehicleCostProfile,
} as unknown as PricingInput;
const config = isObject(data.engineConfig)
  ? (data.engineConfig as unknown as EngineConfig)
  : DEFAULT_ENGINE_CONFIG;

try {
  process.stdout.write(`${JSON.stringify(calculate(input, config), null, 2)}\n`);
} catch (error) {
  if (error instanceof PricingError) {
    process.stderr.write(`${JSON.stringify({ code: error.code, message: error.message })}\n`);
    process.exit(2);
  }
  // Entrada mal formada (por ejemplo un decimal que no lo es) o configuracion invalida.
  fail(`${(error as Error).name}: ${(error as Error).message}`);
}
