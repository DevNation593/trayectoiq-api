import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { APP_ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { CLOCK, type Clock, SystemClock } from './clock/clock.js';
import { Contract } from './contract/contract.js';
import { EMAIL_SENDER } from './email/email-sender.js';
import { SmtpEmailSender } from './email/smtp-email-sender.js';
import { ProblemFilter } from './errors/problem.filter.js';
import { RateLimiter } from './rate-limit/rate-limiter.js';

/** Piezas transversales que cualquier modulo puede inyectar. */
@Global()
@Module({
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
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
  exports: [CLOCK, Contract, RateLimiter, EMAIL_SENDER],
})
export class CoreModule {}
