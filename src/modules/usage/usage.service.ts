import { Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../shared/app-config/app-config.service.js';
import { CLOCK, type Clock } from '../../shared/clock/clock.js';
import { DatabaseService } from '../../shared/database/database.service.js';
import { EntitlementsService } from '../subscriptions/entitlements.service.js';

export type Plan = 'TRIAL' | 'PRO';

export interface Quota {
  plan: Plan;
  limit: number;
  used: number;
  remaining: number;
  /** Cuando se reinicia la cuota. null en trial: es de por vida. */
  resetAt: Date | null;
}

export interface QuotaConsumption {
  allowed: boolean;
  plan: Plan;
  remaining: number;
  /** Periodo sobre el que se consumio; hace falta para devolver la unidad. */
  periodKey: string;
}

interface Period {
  plan: Plan;
  limit: number;
  periodKey: string;
  resetAt: Date | null;
}

/**
 * Cuota de calculos de ruta (02_PRD_MVP.md RF-09). Trial: limite de por vida. Pro: limite por mes
 * calendario en UTC, como uso razonable. La unidad es un calculo de ruta exitoso.
 */
@Injectable()
export class UsageService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async planOf(userId: string): Promise<Plan> {
    return (await this.entitlements.isPro(userId)) ? 'PRO' : 'TRIAL';
  }

  async quota(userId: string): Promise<Quota> {
    const period = await this.period(userId);
    const counter = await this.database.client.quoteUsageCounter.findUnique({
      where: { userId_periodKey: { userId, periodKey: period.periodKey } },
    });
    const used = counter?.used ?? 0;
    return {
      plan: period.plan,
      limit: period.limit,
      used,
      remaining: Math.max(0, period.limit - used),
      resetAt: period.resetAt,
    };
  }

  /**
   * Toma una unidad de cuota de forma atomica: con peticiones simultaneas y una sola unidad
   * disponible, exactamente una la obtiene. Es la sentencia documentada en contract/db/schema.sql.
   */
  async consumeRouteQuota(userId: string): Promise<QuotaConsumption> {
    const { plan, limit, periodKey } = await this.period(userId);
    const now = this.clock.now();
    const rows = await this.database.client.$queryRaw<{ used: number }[]>`
      INSERT INTO quote_usage_counters (user_id, period_key, used, updated_at)
      SELECT ${userId}::uuid, ${periodKey}, 1, ${now} WHERE ${limit}::int > 0
      ON CONFLICT (user_id, period_key) DO UPDATE
        SET used = quote_usage_counters.used + 1, updated_at = ${now}
        WHERE quote_usage_counters.used < ${limit}::int
      RETURNING used`;
    const used = rows[0]?.used;
    return used === undefined
      ? { allowed: false, plan, remaining: 0, periodKey }
      : { allowed: true, plan, remaining: Math.max(0, limit - used), periodKey };
  }

  /** Devuelve una unidad tomada cuya ruta al final no se pudo calcular. Nunca baja de cero. */
  async refundRouteQuota(userId: string, periodKey: string): Promise<void> {
    await this.database.client.quoteUsageCounter.updateMany({
      where: { userId, periodKey, used: { gt: 0 } },
      data: { used: { decrement: 1 }, updatedAt: this.clock.now() },
    });
  }

  private async period(userId: string): Promise<Period> {
    const [plan, settings] = await Promise.all([this.planOf(userId), this.config.load()]);
    if (plan === 'TRIAL') {
      return { plan, limit: settings.trialQuoteLimit, periodKey: 'TRIAL', resetAt: null };
    }
    const now = this.clock.now();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return {
      plan,
      limit: settings.proFairUseMonthlyLimit,
      periodKey: `${year}-${String(month + 1).padStart(2, '0')}`,
      resetAt: new Date(Date.UTC(year, month + 1, 1)),
    };
  }
}
