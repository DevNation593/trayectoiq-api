import { Global, Module } from '@nestjs/common';
import { loadEnv } from './env.js';

export const APP_ENV = Symbol('APP_ENV');

@Global()
@Module({
  providers: [{ provide: APP_ENV, useFactory: () => loadEnv() }],
  exports: [APP_ENV],
})
export class ConfigModule {}
