import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: './',
    include: ['test/**/*.spec.ts'],
    setupFiles: ['test/setup-env.ts'],
    // Cada archivo de integracion o de extremo a extremo crea su base y su pool de conexiones.
    maxWorkers: 6,
    // Los tests de integracion crean bases de datos y lanzan la CLI de Prisma.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
