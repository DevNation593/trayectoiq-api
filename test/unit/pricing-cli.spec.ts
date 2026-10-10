import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, golden, inputOf } from '../support/pricing-fixtures.js';

/**
 * CLI del motor (pnpm pricing:calc <archivo.json>): la usa el concierge MVP para cotizar a mano
 * con exactamente el mismo codigo que usara la API.
 */

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<Outcome> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'scripts/pricing-calc.ts', ...args],
      { encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe('pnpm pricing:calc', () => {
  let directory: string;
  const write = (name: string, content: unknown): string => {
    const file = join(directory, name);
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
  };

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'tiq-pricing-cli-'));
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('reproduce el fixture A y escribe el resultado como JSON en stdout', async () => {
    const file = write('a.json', inputOf('A_moto_10km_negotiate'));

    const { code, stdout, stderr } = await runCli([file]);

    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      pricingEngineVersion: golden.pricingEngineVersion,
      ...fixture('A_moto_10km_negotiate').expected,
    });
  });

  it('acepta un fixture completo: ignora name y expected', async () => {
    const file = write('fixture.json', fixture('C_car_fixed_fee_accept'));

    const { code, stdout } = await runCli([file]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout).thresholds).toEqual({
      floor: '3.60',
      minimum: '7.39',
      recommended: '8.15',
    });
  });

  it('usa engineConfig del archivo cuando viene', async () => {
    const file = write('config.json', {
      ...inputOf('A_moto_10km_negotiate'),
      engineConfig: { ...golden.engineConfig, recommendedStep: '0.10' },
    });

    const { stdout } = await runCli([file]);

    expect(JSON.parse(stdout).thresholds.recommended).toBe('4.30');
  });

  it('una entrada que incumple una regla sale con codigo 2 y el code en stderr', async () => {
    const input = inputOf('A_moto_10km_negotiate');
    input.vehicleCostProfile.fuelEfficiencyKmPerGallon = '0';
    const file = write('invalid.json', input);

    const { code, stdout, stderr } = await runCli([file]);

    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(JSON.parse(stderr)).toMatchObject({ code: 'PRICING_DIVISOR_ZERO' });
  });

  it('sin argumentos muestra el uso y sale con codigo 1', async () => {
    const { code, stderr } = await runCli([]);

    expect(code).toBe(1);
    expect(stderr).toContain('pnpm pricing:calc <archivo.json>');
  });

  it('un archivo inexistente o que no es JSON sale con codigo 1 y un mensaje legible', async () => {
    const missing = await runCli([join(directory, 'no-existe.json')]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('No se pudo leer');

    const broken = await runCli([write('roto.json', '{ no es json')]);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain('No es JSON valido');
  });

  it('un archivo sin la forma esperada sale con codigo 1 y dice que falta', async () => {
    const { code, stderr } = await runCli([write('vacio.json', { route: {} })]);

    expect(code).toBe(1);
    expect(stderr).toContain('quote');
    expect(stderr).toContain('vehicleCostProfile');
  });
});
