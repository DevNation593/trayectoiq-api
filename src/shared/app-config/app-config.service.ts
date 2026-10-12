import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

/** Configuracion que se cambia sin desplegar (tabla app_config), ya tipada y con valores por defecto. */
export interface AppSettings {
  maintenanceMode: boolean;
  /** Calculos de ruta de por vida en el trial (02_PRD_MVP.md RF-09). */
  trialQuoteLimit: number;
  /** Calculos de ruta por mes en Pro, como uso razonable. */
  proFairUseMonthlyLimit: number;
  /** Paso de redondeo del precio recomendado (03_PRICING_ENGINE.md seccion 9.1). */
  pricingRecommendedStep: string;
  minIosVersion: string;
  minAndroidVersion: string;
  /** Dias que una cotizacion guardada conserva coordenadas y etiquetas (06_SECURITY_PRIVACY.md seccion 1). */
  locationRetentionDays: number;
  /** Valores sugeridos para prellenar el vehiculo, por tipo (RF-03). */
  costPresets: Record<string, unknown>;
}

/**
 * Valores iniciales para Quito, pensados para que el onboarding quepa en 5 minutos (hipotesis H4).
 * Son sugerencias editables por el usuario y reemplazables desde app_config sin publicar la app.
 */
const DEFAULT_COST_PRESETS = {
  MOTORCYCLE: {
    fuelType: 'GASOLINE',
    fuelEfficiencyKmPerGallon: '110',
    currentValue: '3200',
    expectedResidualValue: '800',
    remainingUsefulLifeKm: '60000',
    costProfile: {
      fuelPricePerGallon: '2.75',
      tireSetCost: '180',
      tireUsefulLifeKm: '30000',
      monthlyFixedCost: '60',
      expectedMonthlyKm: '2000',
      targetHourlyIncome: '4.5',
      platformCommissionRate: '0.10',
      paymentPercentageRate: '0',
      paymentFixedFee: '0',
      targetProfitMargin: '0.10',
      maintenanceItems: [
        { name: 'Aceite', cost: '25', intervalKm: '3000', enabled: true },
        { name: 'Kit de arrastre', cost: '60', intervalKm: '25000', enabled: true },
      ],
    },
  },
  CAR: {
    fuelType: 'GASOLINE',
    fuelEfficiencyKmPerGallon: '45',
    currentValue: '9000',
    expectedResidualValue: '3000',
    remainingUsefulLifeKm: '80000',
    costProfile: {
      fuelPricePerGallon: '2.75',
      tireSetCost: '400',
      tireUsefulLifeKm: '50000',
      monthlyFixedCost: '120',
      expectedMonthlyKm: '2500',
      targetHourlyIncome: '5',
      platformCommissionRate: '0.10',
      paymentPercentageRate: '0',
      paymentFixedFee: '0',
      targetProfitMargin: '0.08',
      maintenanceItems: [
        { name: 'Aceite', cost: '40', intervalKm: '5000', enabled: true },
        { name: 'Frenos', cost: '120', intervalKm: '30000', enabled: true },
      ],
    },
  },
};

export const DEFAULT_SETTINGS: AppSettings = {
  maintenanceMode: false,
  trialQuoteLimit: 10,
  proFairUseMonthlyLimit: 300,
  pricingRecommendedStep: '0.05',
  minIosVersion: '1.0.0',
  minAndroidVersion: '1.0.0',
  locationRetentionDays: 30,
  costPresets: DEFAULT_COST_PRESETS,
};

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000;
const isVersion = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
const isPositiveDecimal = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) && Number(value) > 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Lee app_config en cada llamada (una consulta minima por clave primaria): un cambio hecho por
 * administracion surte efecto en la siguiente peticion. Un valor guardado con el tipo equivocado
 * se ignora y se usa el valor por defecto, para que un error de captura no tumbe la API.
 */
@Injectable()
export class AppConfigService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async load(): Promise<AppSettings> {
    const rows = await this.database.client.appConfig.findMany();
    const stored = new Map<string, unknown>(rows.map((row) => [row.key, row.value]));
    const pick = <T>(key: string, isValid: (value: unknown) => value is T, fallback: T): T => {
      const value = stored.get(key);
      return isValid(value) ? value : fallback;
    };
    return {
      maintenanceMode: pick(
        'maintenance_mode',
        (value): value is boolean => typeof value === 'boolean',
        DEFAULT_SETTINGS.maintenanceMode,
      ),
      trialQuoteLimit: pick('trial_quote_limit', isCount, DEFAULT_SETTINGS.trialQuoteLimit),
      proFairUseMonthlyLimit: pick(
        'pro_fair_use_monthly_limit',
        isCount,
        DEFAULT_SETTINGS.proFairUseMonthlyLimit,
      ),
      pricingRecommendedStep: pick(
        'pricing_recommended_step',
        isPositiveDecimal,
        DEFAULT_SETTINGS.pricingRecommendedStep,
      ),
      minIosVersion: pick('min_ios_version', isVersion, DEFAULT_SETTINGS.minIosVersion),
      minAndroidVersion: pick('min_android_version', isVersion, DEFAULT_SETTINGS.minAndroidVersion),
      locationRetentionDays: pick(
        'location_retention_days',
        isCount,
        DEFAULT_SETTINGS.locationRetentionDays,
      ),
      costPresets: pick('cost_presets', isRecord, DEFAULT_SETTINGS.costPresets),
    };
  }
}
