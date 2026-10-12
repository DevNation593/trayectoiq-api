import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppConfigService } from '../../shared/app-config/app-config.service.js';
import { CLOCK, type Clock } from '../../shared/clock/clock.js';
import { DatabaseService } from '../../shared/database/database.service.js';
import { AppError } from '../../shared/errors/app-error.js';
import { SignedTokens, TokenError } from '../../shared/signed-tokens/signed-tokens.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { calculate } from '../pricing/domain/pricing-engine.js';
import type { PreviewTokenPayload } from './quote.dto.js';
import { type QuoteRow, WITH_DETAIL } from './saved-quote.dto.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Tamano de pagina del historial cuando el cliente no pide uno (openapi.yaml, listQuotes). */
const DEFAULT_PAGE_SIZE = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = (): AppError => new AppError(404, 'NOT_FOUND', 'La cotizacion no existe');

/** Posicion en el historial: la ultima cotizacion de la pagina anterior. */
interface Cursor {
  createdAt: Date;
  id: string;
}

const encodeCursor = (quote: Cursor): string =>
  Buffer.from(`${quote.createdAt.toISOString()}|${quote.id}`).toString('base64url');

function decodeCursor(cursor: string): Cursor {
  const [timestamp = '', id = ''] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(timestamp);
  if (Number.isNaN(createdAt.getTime()) || !UUID.test(id)) {
    throw new AppError(422, 'VALIDATION_FAILED', 'La peticion no es valida', {
      errors: [{ field: 'cursor', code: 'format', message: 'El cursor no es valido' }],
    });
  }
  return { createdAt, id };
}

/** Historial: cotizaciones guardadas con su snapshot inmutable (02_PRD_MVP.md RF-10). */
@Injectable()
export class SavedQuotesService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SignedTokens) private readonly tokens: SignedTokens,
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Guarda exactamente lo que el usuario vio en el preview (04_ARCHITECTURE.md seccion 3): el motor
   * se vuelve a ejecutar sobre las entradas firmadas del token, no sobre el vehiculo actual.
   * Guardar dos veces el mismo preview devuelve la cotizacion que ya existe.
   */
  async save(userId: string, previewToken: string): Promise<{ quote: QuoteRow; created: boolean }> {
    const payload = await this.readToken(userId, previewToken);
    const existing = await this.findByRequestId(userId, payload.quoteRequestId);
    if (existing) {
      return { quote: existing, created: false };
    }

    const { vehicleCostProfile, engineConfig } = payload.pricingInputSnapshot;
    const result = calculate(
      { route: payload.route, quote: payload.quote, vehicleCostProfile },
      engineConfig,
    );
    const { locationRetentionDays } = await this.config.load();
    const now = this.clock.now();
    const id = randomUUID();

    const created = await this.database.client.$transaction(async (tx) => {
      // El indice unico de quote_request_id decide entre envios simultaneos del mismo preview.
      const { count } = await tx.quote.createMany({
        skipDuplicates: true,
        data: [
          {
            id,
            userId,
            vehicleId: payload.vehicleId,
            quoteRequestId: payload.quoteRequestId,
            pricingEngineVersion: result.pricingEngineVersion,
            routingProvider: payload.routingProvider,
            routingProfile: payload.routingProfile,
            returnMode: engineConfig.returnMode,
            pricingInputSnapshot: {
              vehicleCostProfile,
              engineConfig,
            } as unknown as Prisma.InputJsonObject,
            pickupLat: payload.pickup.lat,
            pickupLng: payload.pickup.lng,
            destinationLat: payload.destination.lat,
            destinationLng: payload.destination.lng,
            pickupLabel: payload.pickup.label ?? null,
            destinationLabel: payload.destination.label ?? null,
            exactLocationExpiresAt: new Date(now.getTime() + locationRetentionDays * DAY_MS),
            ...payload.route,
            waitingSeconds: payload.quote.waitingSeconds,
            emptyReturnProbability: payload.quote.emptyReturnProbability,
            offeredPrice: payload.quote.offeredPrice,
            tollsAmount: payload.quote.tollsAmount,
            parkingAmount: payload.quote.parkingAmount,
            otherDirectCostAmount: payload.quote.otherDirectCostAmount,
            operatingCostRaw: result.costsRaw.operating,
            floorPriceRaw: result.pricesRaw.floor,
            minimumPriceRaw: result.pricesRaw.minimum,
            recommendedPriceRaw: result.pricesRaw.recommended,
            floorPrice: result.thresholds.floor,
            minimumPrice: result.thresholds.minimum,
            recommendedPrice: result.thresholds.recommended,
            earningsPerHourRaw: result.earningsPerHourRaw,
            earningsPerKmRaw: result.earningsPerKmRaw,
            recommendation: result.decision,
            createdAt: now,
          },
        ],
      });
      if (count === 0) {
        return false;
      }
      await tx.quoteCostBreakdown.create({
        data: {
          quoteId: id,
          fuelCost: result.costsRaw.fuel,
          maintenanceCost: result.costsRaw.maintenance,
          tireCost: result.costsRaw.tires,
          depreciationCost: result.costsRaw.depreciation,
          fixedCost: result.costsRaw.fixed,
          tollsCost: result.costsRaw.tolls,
          parkingCost: result.costsRaw.parking,
          otherCost: result.costsRaw.other,
          driverTargetCompensation: result.costsRaw.targetCompensation,
          createdAt: now,
        },
      });
      return true;
    });

    const quote = await this.findByRequestId(userId, payload.quoteRequestId);
    if (!quote) {
      throw new Error(`No se encontro la cotizacion del preview ${payload.quoteRequestId}`);
    }
    if (created) {
      await this.analytics.record({
        name: 'quote_saved',
        userId,
        properties: {
          quote_id: quote.id,
          recommendation: quote.recommendation,
          pricing_engine_version: quote.pricingEngineVersion,
        },
      });
    }
    return { quote, created };
  }

  /** La cotizacion del usuario. Una ajena responde igual que una inexistente. */
  async find(userId: string, quoteId: string): Promise<QuoteRow> {
    const quote = await this.database.client.quote.findFirst({
      where: { id: quoteId, userId },
      include: WITH_DETAIL,
    });
    if (!quote) {
      throw notFound();
    }
    return quote;
  }

  /**
   * Una pagina del historial, de la mas nueva a la mas antigua. El cursor apunta a una cotizacion,
   * no a un numero de pagina: guardar otra mientras se recorre no repite ni omite ninguna.
   */
  async list(
    userId: string,
    options: { cursor?: string; limit?: number },
  ): Promise<{ items: QuoteRow[]; nextCursor: string | null }> {
    const limit = options.limit ?? DEFAULT_PAGE_SIZE;
    const after = options.cursor === undefined ? null : decodeCursor(options.cursor);
    const rows = await this.database.client.quote.findMany({
      where: {
        userId,
        ...(after
          ? {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      include: WITH_DETAIL,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // Una de mas, para saber si queda otra pagina sin una segunda consulta.
      take: limit + 1,
    });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
  }

  private findByRequestId(userId: string, quoteRequestId: string): Promise<QuoteRow | null> {
    return this.database.client.quote.findFirst({
      where: { quoteRequestId, userId },
      include: WITH_DETAIL,
    });
  }

  private async readToken(userId: string, previewToken: string): Promise<PreviewTokenPayload> {
    try {
      const { payload } = await this.tokens.verify<PreviewTokenPayload>(
        'preview',
        previewToken,
        userId,
      );
      return payload;
    } catch (error) {
      if (!(error instanceof TokenError)) {
        throw error;
      }
      throw error.reason === 'expired'
        ? new AppError(
            422,
            'PREVIEW_TOKEN_EXPIRED',
            'La cotizacion ya vencio; vuelve a calcularla para guardarla',
          )
        : new AppError(422, 'PREVIEW_TOKEN_INVALID', 'La cotizacion no se puede guardar');
    }
  }
}
