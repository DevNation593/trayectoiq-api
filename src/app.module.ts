import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { CoreModule } from './shared/core.module.js';
import { DatabaseModule } from './shared/database/database.module.js';

@Module({
  imports: [ConfigModule, CoreModule, DatabaseModule, HealthModule],
})
export class AppModule {}
