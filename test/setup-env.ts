import 'reflect-metadata';

// En CI las variables llegan del entorno; en local se leen de .env.test o, si no existe, de .env.
if (!process.env.DATABASE_URL) {
  for (const file of ['.env.test', '.env']) {
    try {
      process.loadEnvFile(file);
      break;
    } catch {
      // Se prueba el siguiente archivo.
    }
  }
}
process.env.NODE_ENV ??= 'test';
