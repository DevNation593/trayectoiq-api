import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

/**
 * Dependencias permitidas entre modulos de dominio: 04_ARCHITECTURE.md seccion 2.
 * Cambiar esta tabla es cambiar la arquitectura: va con su ADR o su actualizacion del documento.
 */
const ALLOWED_DEPENDENCIES = {
  auth: ['users'],
  users: [],
  vehicles: ['users', 'usage'],
  places: [],
  routing: [],
  pricing: [],
  quotes: ['vehicles', 'routing', 'pricing', 'usage'],
  decisions: ['quotes'],
  usage: ['subscriptions'],
  subscriptions: [],
  analytics: [],
  jobs: [],
  admin: '*',
};

/** Infraestructura que cualquier modulo puede usar, salvo pricing y la propia infraestructura. */
const INFRASTRUCTURE_MODULES = ['jobs', 'analytics'];

const MODULES = Object.keys(ALLOWED_DEPENDENCIES);

/** Detecta la importacion de un modulo por ruta relativa (../x/...) o absoluta (.../modules/x/...). */
const moduleImport = (name) => `^(\\.\\./)+${name}(/|$)|/modules/${name}(/|$)`;

function forbiddenModules(name) {
  const allowed = ALLOWED_DEPENDENCIES[name];
  if (allowed === '*') return [];
  const usable = new Set([name, ...allowed]);
  if (name !== 'pricing' && !INFRASTRUCTURE_MODULES.includes(name)) {
    INFRASTRUCTURE_MODULES.forEach((infrastructure) => usable.add(infrastructure));
  }
  return MODULES.filter((other) => !usable.has(other));
}

const moduleBoundaries = MODULES.map((name) => {
  const patterns = forbiddenModules(name).map((other) => ({
    regex: moduleImport(other),
    message: `El modulo "${name}" no puede depender de "${other}" (04_ARCHITECTURE.md seccion 2).`,
  }));
  if (name === 'pricing') {
    patterns.push(
      {
        regex: '^(@nestjs/|@prisma/|node:)|^(fastify|pg|rxjs)$|(^|/)generated/',
        message:
          'pricing es dominio puro: sin framework, base de datos, red ni reloj (ADR-004).',
      },
      {
        regex: '(^|/)shared/(?!fraction/)',
        message: 'pricing solo puede usar shared/fraction (ADR-004).',
      },
    );
  }
  return {
    files: [`src/modules/${name}/**/*.ts`],
    rules: { 'no-restricted-imports': ['error', { patterns }] },
  };
}).filter((config) => config.rules['no-restricted-imports'][1].patterns.length > 0);

export default defineConfig(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'src/generated/**',
      'contract/**',
      '.superpowers/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      // En tests se accede a filas recien insertadas; noUncheckedIndexedAccess ya obliga a decidirlo.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Un nombre que empieza por "_" declara que se descarta a proposito (por ejemplo al desestructurar).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  ...moduleBoundaries,
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(^|/)modules/',
              message: 'shared no puede depender de modulos de dominio (04_ARCHITECTURE.md seccion 2).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
);
