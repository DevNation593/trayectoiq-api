import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../shared/clock/clock.js';
import { DatabaseService } from '../../shared/database/database.service.js';

/**
 * Si un usuario tiene Pro, segun el estado que el backend guardo al verificar con la tienda
 * (ADR-006). La app nunca decide esto por su cuenta.
 */
@Injectable()
export class EntitlementsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async isPro(userId: string): Promise<boolean> {
    const active = await this.database.client.subscription.count({
      where: {
        userId,
        entitlementActive: true,
        OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: this.clock.now() } }],
      },
    });
    return active > 0;
  }
}
