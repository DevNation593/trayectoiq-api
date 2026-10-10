import { defineConfig } from 'prisma/config';

// Prisma 7 no carga .env por su cuenta. En CI y en contenedores la variable ya viene del entorno.
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile('.env');
  } catch {
    // Sin .env: "prisma generate" no necesita conexion; "migrate" fallara con un mensaje claro.
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
