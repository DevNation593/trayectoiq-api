import { Controller, Get, Inject } from '@nestjs/common';
import { type AuthContext, CurrentAuth } from '../../shared/auth/auth-context.js';
import { Operation } from '../../shared/contract/contract.guard.js';
import { type Plan, UsageService } from './usage.service.js';

interface QuotaDto {
  plan: Plan;
  limit: number;
  used: number;
  remaining: number;
  resetAt: string | null;
}

@Controller('usage')
export class UsageController {
  constructor(@Inject(UsageService) private readonly usage: UsageService) {}

  @Get('quote-quota')
  @Operation('getQuoteQuota')
  async getQuoteQuota(@CurrentAuth() auth: AuthContext): Promise<QuotaDto> {
    const quota = await this.usage.quota(auth.userId);
    return { ...quota, resetAt: quota.resetAt?.toISOString() ?? null };
  }
}
