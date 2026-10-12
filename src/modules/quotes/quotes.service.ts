import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { AppConfigService } from '../../shared/app-config/app-config.service.js';
import type { AuthContext } from '../../shared/auth/auth-context.js';
import { CLOCK, type Clock } from '../../shared/clock/clock.js';
import { AppError } from '../../shared/errors/app-error.js';
import { decodePlaceId, InvalidPlaceIdError } from '../../shared/geo/place-id.js';
import { SignedTokens, TokenError } from '../../shared/signed-tokens/signed-tokens.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { PricingError } from '../pricing/domain/errors.js';
import { calculate } from '../pricing/domain/pricing-engine.js';
import {
  DEFAULT_ENGINE_CONFIG,
  type EngineConfig,
  type QuoteInputs,
} from '../pricing/domain/types.js';
import {
  RoutingError,
  type RoutingProfile,
  type RoutingProvider,
} from '../routing/domain/routing-provider.js';
import { ROUTING_PROVIDER } from '../routing/routing.module.js';
import { UsageService } from '../usage/usage.service.js';
import { toVehicleDto } from '../vehicles/vehicle.dto.js';
import { VehiclesService } from '../vehicles/vehicles.service.js';
import {
  type LocationInput,
  type PreviewRequest,
  type PreviewResponse,
  type PreviewTokenPayload,
  type RoutePoint,
  type RouteTokenPayload,
  toPricingProfile,
} from './quote.dto.js';
import { waitingMinutesBucket } from './quote-analytics.js';
import { DISCLAIMER, priceText } from './saved-quote.dto.js';

/** Vigencia de routeToken y previewToken desde que se calcula la ruta (02_PRD_MVP.md RF-09). */
const TOKEN_TTL_MS = 15 * 60 * 1000;

const ROUTING_PROFILES: Record<'MOTORCYCLE' | 'CAR', RoutingProfile> = {
  MOTORCYCLE: 'MOTORCYCLE',
  CAR: 'CAR',
};

const invalidRouteInput = (detail: string): AppError =>
  new AppError(422, 'QUOTE_INVALID_ROUTE_INPUT', 'Faltan o sobran datos de la ruta', { detail });

function routingAppError(error: RoutingError): AppError {
  switch (error.code) {
    case 'ROUTE_UNAVAILABLE':
      return new AppError(422, error.code, 'No se encontro una ruta entre esos puntos');
    case 'OUT_OF_SERVICE_AREA':
      return new AppError(422, error.code, 'Algun punto esta fuera del area de servicio');
    default:
      return new AppError(
        503,
        'ROUTING_PROVIDER_UNAVAILABLE',
        'El calculo de rutas no esta disponible; intenta de nuevo en un momento',
      );
  }
}

/** Lo que se sabe de un preview en curso, para el evento que deja al terminar o al fallar. */
interface PreviewTrace {
  stage: 'validation' | 'quota' | 'routing' | 'pricing';
  routingProvider: string | null;
  routeReused: boolean;
}

interface ResolvedRoute {
  payload: RouteTokenPayload;
  token: string;
  expiresAt: Date;
}

@Injectable()
export class QuotesService {
  constructor(
    @Inject(VehiclesService) private readonly vehicles: VehiclesService,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(ROUTING_PROVIDER) private readonly routing: RoutingProvider,
    @Inject(SignedTokens) private readonly tokens: SignedTokens,
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(APP_ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Calcula una cotizacion sin guardarla (04_ARCHITECTURE.md seccion 3) y deja el evento de exito
   * o de falla con la etapa en que ocurrio.
   */
  async preview(auth: AuthContext, request: PreviewRequest): Promise<PreviewResponse> {
    const startedAt = this.clock.now();
    const trace: PreviewTrace = { stage: 'validation', routingProvider: null, routeReused: false };
    const latency = (): number => this.clock.now().getTime() - startedAt.getTime();
    try {
      const response = await this.compute(auth, request, trace);
      await this.analytics.record({
        name: 'quote_preview_succeeded',
        userId: auth.userId,
        properties: {
          quote_request_id: response.quoteRequestId,
          route_reused: trace.routeReused,
          routing_provider: response.route.routingProvider,
          routing_profile: response.route.routingProfile,
          latency_ms: latency(),
          recommendation: response.recommendation,
          has_offer: response.offeredPrice !== null,
          pricing_engine_version: response.pricingEngineVersion,
        },
      });
      return response;
    } catch (error) {
      await this.analytics.record({
        name: 'quote_preview_failed',
        userId: auth.userId,
        properties: {
          error_code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
          stage: trace.stage,
          routing_provider: trace.routingProvider,
          latency_ms: latency(),
        },
      });
      throw error;
    }
  }

  /**
   * Con un routeToken vigente no se rutea ni se consume cuota; con puntos nuevos se toma una unidad
   * de cuota, que se devuelve si al final no se pudo calcular.
   */
  private async compute(
    auth: AuthContext,
    request: PreviewRequest,
    trace: PreviewTrace,
  ): Promise<PreviewResponse> {
    if (!auth.emailVerified) {
      throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verifica tu correo para poder cotizar');
    }
    const vehicle = toVehicleDto(await this.vehicles.find(auth.userId, request.vehicleId));
    const profile = ROUTING_PROFILES[vehicle.type];

    const quote: QuoteInputs = {
      waitingSeconds: request.waitingSeconds,
      emptyReturnProbability: request.emptyReturnProbability,
      tollsAmount: request.tollsAmount,
      parkingAmount: request.parkingAmount,
      otherDirectCostAmount: request.otherDirectCostAmount,
      offeredPrice: request.offeredPrice ?? null,
    };
    const settings = await this.config.load();
    const engineConfig: EngineConfig = {
      ...DEFAULT_ENGINE_CONFIG,
      recommendedStep: settings.pricingRecommendedStep,
    };
    const vehicleCostProfile = toPricingProfile(vehicle);
    const price = (route: RouteTokenPayload['route']) => {
      trace.stage = 'pricing';
      try {
        return calculate({ route, quote, vehicleCostProfile }, engineConfig);
      } catch (error) {
        if (error instanceof PricingError) {
          throw new AppError(422, error.code, error.message);
        }
        throw error;
      }
    };

    const reused =
      request.routeToken === undefined
        ? null
        : await this.reuseRoute(auth.userId, request.routeToken, profile);
    const points = reused ? null : this.readPoints(request);
    trace.routeReused = reused !== null;
    trace.routingProvider = reused ? reused.payload.routingProvider : this.env.routingProvider;
    await this.analytics.record({
      name: 'quote_preview_requested',
      userId: auth.userId,
      properties: {
        vehicle_type: vehicle.type,
        pickup_mode: reused ? reused.payload.pickupMode : (points?.pickupMode ?? null),
        has_offer: quote.offeredPrice !== null,
        return_probability_bucket: quote.emptyReturnProbability,
        waiting_minutes_bucket: waitingMinutesBucket(quote.waitingSeconds),
        plan: await this.usage.planOf(auth.userId),
      },
    });

    let resolved: ResolvedRoute;
    let result: ReturnType<typeof calculate>;
    let remaining: number;
    let plan: PreviewResponse['quota']['plan'];

    if (reused) {
      resolved = reused;
      result = price(resolved.payload.route);
      ({ plan, remaining } = await this.usage.quota(auth.userId));
    } else if (points) {
      trace.stage = 'quota';
      const consumption = await this.usage.consumeRouteQuota(auth.userId);
      if (!consumption.allowed) {
        throw new AppError(
          402,
          'QUOTA_EXHAUSTED',
          consumption.plan === 'TRIAL'
            ? 'Usaste todas las cotizaciones de prueba'
            : 'Alcanzaste el limite de cotizaciones de este mes',
        );
      }
      try {
        trace.stage = 'routing';
        resolved = await this.computeRoute(auth.userId, profile, points);
        result = price(resolved.payload.route);
      } catch (error) {
        // Una ruta que no se pudo calcular o cotizar no cuesta cuota.
        await this.usage.refundRouteQuota(auth.userId, consumption.periodKey);
        throw error;
      }
      ({ plan, remaining } = consumption);
    } else {
      throw new Error('Un preview sin routeToken siempre tiene puntos');
    }

    const quoteRequestId = randomUUID();
    const previewPayload: PreviewTokenPayload = {
      ...resolved.payload,
      quoteRequestId,
      vehicleId: vehicle.id,
      quote,
      pricingInputSnapshot: { vehicleCostProfile, engineConfig },
    };
    const previewToken = await this.tokens.sign(
      'preview',
      auth.userId,
      previewPayload,
      resolved.expiresAt,
    );

    return {
      quoteRequestId,
      previewToken,
      routeToken: resolved.token,
      expiresAt: resolved.expiresAt.toISOString(),
      quota: { plan, remaining },
      pricingEngineVersion: result.pricingEngineVersion,
      currency: 'USD',
      route: {
        ...resolved.payload.route,
        effectiveDistanceMeters: result.api.effectiveDistanceMeters,
        effectiveDurationSeconds: result.api.effectiveDurationSeconds,
        returnMode: engineConfig.returnMode,
        routingProvider: resolved.payload.routingProvider,
        routingProfile: resolved.payload.routingProfile,
      },
      costs: result.api.costs,
      pricing: result.thresholds,
      offeredPrice: quote.offeredPrice === null ? null : priceText(quote.offeredPrice),
      earningsPerHour: result.api.earningsPerHour,
      earningsPerKm: result.api.earningsPerKm,
      recommendation: result.decision,
      disclaimer: DISCLAIMER,
    };
  }

  private async reuseRoute(
    userId: string,
    routeToken: string,
    profile: RoutingProfile,
  ): Promise<ResolvedRoute> {
    let verified;
    try {
      verified = await this.tokens.verify<RouteTokenPayload>('route', routeToken, userId);
    } catch (error) {
      if (error instanceof TokenError && error.reason === 'expired') {
        throw new AppError(
          422,
          'ROUTE_TOKEN_EXPIRED',
          'La ruta calculada ya vencio; vuelve a calcularla',
        );
      }
      throw invalidRouteInput('El routeToken no es valido para esta cuenta.');
    }
    if (verified.payload.profile !== profile) {
      throw invalidRouteInput('La ruta se calculo para otro tipo de vehiculo.');
    }
    return { payload: verified.payload, token: routeToken, expiresAt: verified.expiresAt };
  }

  private readPoints(request: PreviewRequest): {
    pickupMode: RouteTokenPayload['pickupMode'];
    origin?: RoutePoint;
    pickup: RoutePoint;
    destination: RoutePoint;
  } {
    const { pickupMode, pickup, destination, currentLocation } = request;
    if (!pickupMode || !pickup || !destination) {
      throw invalidRouteInput('Envia routeToken, o pickupMode con pickup y destination.');
    }
    if (pickupMode === 'CURRENT_LOCATION' && !currentLocation) {
      throw invalidRouteInput('Con pickupMode CURRENT_LOCATION hace falta currentLocation.');
    }
    return {
      pickupMode,
      pickup: this.resolveLocation(pickup),
      destination: this.resolveLocation(destination),
      ...(pickupMode === 'CURRENT_LOCATION' && currentLocation
        ? { origin: this.resolveLocation(currentLocation) }
        : {}),
    };
  }

  private resolveLocation(location: LocationInput): RoutePoint {
    if (!('placeId' in location)) {
      return {
        lat: location.lat,
        lng: location.lng,
        ...(location.label ? { label: location.label } : {}),
      };
    }
    try {
      const place = decodePlaceId(location.placeId);
      return { lat: place.lat, lng: place.lng, label: place.label };
    } catch (error) {
      if (error instanceof InvalidPlaceIdError) {
        throw new AppError(422, 'PLACE_NOT_FOUND', 'El lugar elegido no es valido');
      }
      throw error;
    }
  }

  private async computeRoute(
    userId: string,
    profile: RoutingProfile,
    points: ReturnType<QuotesService['readPoints']>,
  ): Promise<ResolvedRoute> {
    const coordinates = ({ lat, lng }: RoutePoint) => ({ lat, lng });
    let route;
    try {
      route = await this.routing.route({
        profile,
        pickup: coordinates(points.pickup),
        destination: coordinates(points.destination),
        ...(points.origin ? { origin: coordinates(points.origin) } : {}),
      });
    } catch (error) {
      throw error instanceof RoutingError ? routingAppError(error) : error;
    }

    const payload: RouteTokenPayload = {
      profile,
      pickupMode: points.pickupMode,
      pickup: points.pickup,
      destination: points.destination,
      route: {
        pickupDistanceMeters: route.pickupDistanceMeters,
        pickupDurationSeconds: route.pickupDurationSeconds,
        tripDistanceMeters: route.tripDistanceMeters,
        tripDurationSeconds: route.tripDurationSeconds,
      },
      routingProvider: route.provider,
      routingProfile: route.routingProfile,
    };
    // El vencimiento se fija al segundo: es la precision con que viaja dentro del token.
    const expiresAt = new Date(
      Math.floor((this.clock.now().getTime() + TOKEN_TTL_MS) / 1000) * 1000,
    );
    return {
      payload,
      token: await this.tokens.sign('route', userId, payload, expiresAt),
      expiresAt,
    };
  }
}
