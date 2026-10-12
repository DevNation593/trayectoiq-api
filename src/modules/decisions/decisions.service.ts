import { Inject, Injectable } from '@nestjs/common';
import type { QuoteDecision } from '../../generated/prisma/client.js';
import { CLOCK, type Clock } from '../../shared/clock/clock.js';
import type { FieldError } from '../../shared/contract/contract.js';
import { DatabaseService } from '../../shared/database/database.service.js';
import { AppError } from '../../shared/errors/app-error.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import type { DecisionAction, Influence, QuoteRow } from '../quotes/saved-quote.dto.js';
import { SavedQuotesService } from '../quotes/saved-quotes.service.js';
import { finalPriceBand, initialOfferRelation } from './decision-analytics.js';

/** Esquema QuoteDecisionRequest de openapi.yaml. Llega ya validado en forma por ContractGuard. */
export interface DecisionInput {
  action: DecisionAction;
  finalPrice?: string | null;
  influence: Influence;
  notes?: string;
}

/** Tiempo, desde que se guardo la cotizacion, en que la decision se puede registrar o corregir (RF-11). */
const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

const ACCEPTING: readonly DecisionAction[] = ['ACCEPTED_ORIGINAL_OFFER', 'NEGOTIATED_AND_ACCEPTED'];

/** Decision real del conductor sobre una cotizacion guardada (02_PRD_MVP.md RF-11). */
@Injectable()
export class DecisionsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SavedQuotesService) private readonly quotes: SavedQuotesService,
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Hay una decision por cotizacion: registrar otra dentro del plazo reemplaza a la anterior. */
  async record(
    userId: string,
    quoteId: string,
    input: DecisionInput,
  ): Promise<{ quote: QuoteRow; decision: QuoteDecision }> {
    const quote = await this.quotes.find(userId, quoteId);
    const now = this.clock.now();
    if (now.getTime() - quote.createdAt.getTime() > EDIT_WINDOW_MS) {
      throw new AppError(
        409,
        'DECISION_LOCKED',
        'Pasaron mas de 24 horas desde la cotizacion; la decision ya no se puede cambiar',
      );
    }
    const errors = this.validate(input, quote);
    if (errors.length > 0) {
      throw new AppError(422, 'VALIDATION_FAILED', 'La peticion no es valida', { errors });
    }

    const values = {
      action: input.action,
      finalPrice: input.finalPrice ?? null,
      influence: input.influence,
      notes: input.notes ?? null,
      decidedAt: now,
      updatedAt: now,
    };
    const decision = await this.database.client.quoteDecision.upsert({
      where: { quoteId: quote.id },
      create: { quoteId: quote.id, ...values },
      update: values,
    });
    // Sin precio exacto ni nota: solo el tramo (08_ANALYTICS_VALIDATION.md seccion 2).
    await this.analytics.record({
      name: 'quote_decision_recorded',
      userId,
      properties: {
        quote_id: quote.id,
        real_action: input.action,
        influence: input.influence,
        recommendation: quote.recommendation,
        ...(values.finalPrice === null
          ? {}
          : { final_price_band: finalPriceBand(values.finalPrice) }),
        initial_offer_relation: initialOfferRelation(quote.recommendation),
      },
    });
    return { quote, decision };
  }

  private validate(input: DecisionInput, quote: QuoteRow): FieldError[] {
    const errors: FieldError[] = [];
    if (ACCEPTING.includes(input.action) && (input.finalPrice ?? null) === null) {
      errors.push({
        field: 'finalPrice',
        code: 'required',
        message: 'Hace falta el precio final cuando el viaje se acepto',
      });
    }
    if (input.action === 'ACCEPTED_ORIGINAL_OFFER' && quote.offeredPrice === null) {
      errors.push({
        field: 'action',
        code: 'noOffer',
        message: 'La cotizacion no tenia una oferta que aceptar',
      });
    }
    return errors;
  }
}
