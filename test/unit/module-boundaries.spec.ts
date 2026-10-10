import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * La tabla de dependencias entre modulos (04_ARCHITECTURE.md seccion 2) se hace cumplir con ESLint.
 * Estos tests fijan el comportamiento de esa regla sobre archivos virtuales.
 */

const RULE = 'no-restricted-imports';

describe('limites entre modulos', () => {
  let eslint: ESLint;

  beforeAll(() => {
    eslint = new ESLint();
  });

  async function violations(filePath: string, code: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, { filePath });
    return (result?.messages ?? [])
      .filter((message) => message.ruleId === RULE)
      .map((message) => message.message);
  }

  describe('pricing es dominio puro', () => {
    const file = 'src/modules/pricing/domain/pricing-engine.ts';

    it.each([
      ['el framework', `import { Injectable } from '@nestjs/common';`],
      ['Prisma', `import { PrismaPg } from '@prisma/adapter-pg';`],
      [
        'el cliente generado',
        `import { PrismaClient } from '../../../generated/prisma/client.js';`,
      ],
      ['el servidor HTTP', `import fastify from 'fastify';`],
      ['otro modulo', `import { QuotesService } from '../../quotes/quotes.service.js';`],
      [
        'la base de datos',
        `import { DatabaseService } from '../../../shared/database/database.service.js';`,
      ],
      ['el reloj y la red de Node', `import { request } from 'node:http';`],
    ])('no puede importar %s', async (_name, code) => {
      expect(await violations(file, `${code}\nexport {};\n`)).toHaveLength(1);
    });

    it('puede importar sus propios archivos y las fracciones compartidas', async () => {
      const code = [
        `import { validate } from './validations.js';`,
        `import { Fraction } from '../../../shared/fraction/fraction.js';`,
        `export { validate, Fraction };`,
      ].join('\n');
      expect(await violations(file, `${code}\n`)).toEqual([]);
    });
  });

  describe('dependencias permitidas entre modulos', () => {
    it('quotes puede importar pricing, routing, vehicles y usage', async () => {
      const code = [
        `import { calculate } from '../pricing/domain/pricing-engine.js';`,
        `import { RoutingService } from '../routing/routing.service.js';`,
        `import { VehiclesService } from '../vehicles/vehicles.service.js';`,
        `import { UsageService } from '../usage/usage.service.js';`,
        `export { calculate, RoutingService, VehiclesService, UsageService };`,
      ].join('\n');
      expect(await violations('src/modules/quotes/quotes.service.ts', `${code}\n`)).toEqual([]);
    });

    it('quotes no puede importar subscriptions ni admin', async () => {
      const code = [
        `import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';`,
        `import { AdminService } from '../admin/admin.service.js';`,
        `export { SubscriptionsService, AdminService };`,
      ].join('\n');
      const found = await violations('src/modules/quotes/quotes.service.ts', `${code}\n`);
      expect(found).toHaveLength(2);
      expect(found[0]).toContain('04_ARCHITECTURE.md');
    });

    it('la restriccion aplica tambien desde subcarpetas del modulo', async () => {
      const code = `import { AdminService } from '../../admin/admin.service.js';\nexport { AdminService };\n`;
      expect(await violations('src/modules/quotes/dto/quote.dto.ts', code)).toHaveLength(1);
    });

    it('users no depende de ningun otro modulo de dominio', async () => {
      const code = `import { AuthService } from '../auth/auth.service.js';\nexport { AuthService };\n`;
      expect(await violations('src/modules/users/users.service.ts', code)).toHaveLength(1);
    });

    it('cualquier modulo salvo pricing puede usar jobs y analytics', async () => {
      const code = [
        `import { JobsService } from '../jobs/jobs.service.js';`,
        `import { AnalyticsService } from '../analytics/analytics.service.js';`,
        `export { JobsService, AnalyticsService };`,
      ].join('\n');
      expect(await violations('src/modules/users/users.service.ts', `${code}\n`)).toEqual([]);
    });

    it('admin puede importar cualquier modulo', async () => {
      const code = `import { UsersService } from '../users/users.service.js';\nexport { UsersService };\n`;
      expect(await violations('src/modules/admin/admin.service.ts', code)).toEqual([]);
    });

    it('un modulo puede importarse a si mismo y a shared', async () => {
      const code = [
        `import { QuoteDto } from './dto/quote.dto.js';`,
        `import { DatabaseService } from '../../shared/database/database.service.js';`,
        `export { QuoteDto, DatabaseService };`,
      ].join('\n');
      expect(await violations('src/modules/quotes/quotes.service.ts', `${code}\n`)).toEqual([]);
    });
  });

  it('shared no puede importar modulos de dominio', async () => {
    const code = `import { QuotesService } from '../../modules/quotes/quotes.service.js';\nexport { QuotesService };\n`;
    expect(await violations('src/shared/errors/problem.ts', code)).toHaveLength(1);
  });
});
