import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { AppConfigController } from './app-config/app-config.controller.js';
import { AppConfigService } from './app-config/app-config.service.js';
import { AccessTokens } from './auth/access-tokens.js';
import { AuthGuard } from './auth/auth.guard.js';
import { CLOCK, type Clock, SystemClock } from './clock/clock.js';
import { ContractGuard } from './contract/contract.guard.js';
import { Contract } from './contract/contract.js';
import { EMAIL_SENDER } from './email/email-sender.js';
import { SmtpEmailSender } from './email/smtp-email-sender.js';
import { ProblemFilter } from './errors/problem.filter.js';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor.js';
import { RateLimitGuard } from './rate-limit/rate-limit.guard.js';
import { RateLimiter } from './rate-limit/rate-limiter.js';

/** Piezas transversales que cualquier modulo puede inyectar. */
@Global()
@Module({
  controllers: [AppConfigController],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: Contract, useFactory: () => Contract.load() },
    {
      provide: RateLimiter,
      useFactory: (clock: Clock) => new RateLimiter(clock),
      inject: [CLOCK],
    },
    {
      provide: EMAIL_SENDER,
      useFactory: (env: Env) => new SmtpEmailSender(env.smtpUrl, env.emailFrom),
      inject: [APP_ENV],
    },
    AccessTokens,
    AppConfigService,
    { provide: APP_FILTER, useClass: ProblemFilter },
    // El orden importa: primero quien eres (401), luego cuanto pides (429), luego que pides (422).
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: ContractGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [CLOCK, Contract, RateLimiter, EMAIL_SENDER, AccessTokens, AppConfigService],
})
export class CoreModule {}
