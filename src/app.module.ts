import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { JobsModule } from './modules/jobs/jobs.module.js';
import { PlacesModule } from './modules/places/places.module.js';
import { QuotesModule } from './modules/quotes/quotes.module.js';
import { UsageModule } from './modules/usage/usage.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { VehiclesModule } from './modules/vehicles/vehicles.module.js';
import { CoreModule } from './shared/core.module.js';
import { DatabaseModule } from './shared/database/database.module.js';

@Module({
  imports: [
    ConfigModule,
    CoreModule,
    DatabaseModule,
    JobsModule,
    HealthModule,
    UsersModule,
    AuthModule,
    UsageModule,
    VehiclesModule,
    PlacesModule,
    QuotesModule,
  ],
})
export class AppModule {}
