import { readFileSync } from 'node:fs';
import type {
  EngineConfig,
  PricingInput,
  PricingResult,
} from '../../src/modules/pricing/domain/types.js';

export interface GoldenFixture extends PricingInput {
  name: string;
  expected: Omit<PricingResult, 'pricingEngineVersion'>;
}

export interface GoldenFile {
  pricingEngineVersion: string;
  engineConfig: EngineConfig;
  fixtures: GoldenFixture[];
}

export interface InvalidCase {
  name: string;
  overrides: Record<string, unknown>;
  expectedCode: string;
}

export interface InvalidFile {
  baseFixture: string;
  invalidFixtures: InvalidCase[];
}

const read = <T>(file: string): T =>
  JSON.parse(readFileSync(`contract/fixtures/${file}`, 'utf8')) as T;

export const golden = read<GoldenFile>('pricing-engine-golden.json');
export const invalid = read<InvalidFile>('pricing-engine-invalid.json');

export function fixture(name: string): GoldenFixture {
  const found = golden.fixtures.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`No existe el fixture ${name}`);
  }
  return found;
}

/** Entrada del motor a partir de un fixture, como copia profunda que el test puede modificar. */
export function inputOf(name: string): PricingInput {
  const { route, quote, vehicleCostProfile } = fixture(name);
  return structuredClone({ route, quote, vehicleCostProfile });
}

/** Asigna `value` en una ruta tipo "vehicleCostProfile.maintenanceItems[0].intervalKm". */
export function setPath(target: object, path: string, value: unknown): void {
  const parts = path.match(/[^.[\]]+/g) ?? [];
  const last = parts.pop();
  if (last === undefined) {
    throw new Error(`Ruta vacia: ${path}`);
  }
  let cursor = target as Record<string, unknown>;
  for (const part of parts) {
    const next = cursor[part];
    if (typeof next !== 'object' || next === null) {
      throw new Error(`La ruta ${path} no existe en el fixture`);
    }
    cursor = next as Record<string, unknown>;
  }
  if (!(last in cursor)) {
    throw new Error(`La ruta ${path} no existe en el fixture`);
  }
  cursor[last] = value;
}
