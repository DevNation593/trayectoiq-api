import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { CLOCK, type Clock } from '../../shared/clock/clock.js';
import { DatabaseService } from '../../shared/database/database.service.js';
import { AppError } from '../../shared/errors/app-error.js';
import { Fraction } from '../../shared/fraction/fraction.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { type Plan, UsageService } from '../usage/usage.service.js';
import {
  toVehicleDto,
  validateVehicle,
  type VehicleDto,
  type VehicleInput,
  type VehicleWithProfile,
} from './vehicle.dto.js';

/** Vehiculos no archivados que admite cada plan (02_PRD_MVP.md RF-02). */
const VEHICLE_LIMITS: Record<Plan, number> = { TRIAL: 1, PRO: 5 };

const WITH_PROFILE = {
  vehicleCostProfiles: { where: { isActive: true }, include: { maintenanceItems: true } },
} as const;

type Tx = Prisma.TransactionClient;

const notFound = (): AppError => new AppError(404, 'NOT_FOUND', 'El vehiculo no existe');

@Injectable()
export class VehiclesService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(userId: string): Promise<VehicleDto[]> {
    const vehicles = await this.database.client.vehicle.findMany({
      where: { userId, archivedAt: null },
      include: WITH_PROFILE,
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    return vehicles.map(toVehicleDto);
  }

  /** El vehiculo del usuario, no archivado. Uno ajeno responde igual que uno inexistente. */
  async find(userId: string, vehicleId: string): Promise<VehicleWithProfile> {
    const vehicle = await this.database.client.vehicle.findFirst({
      where: { id: vehicleId, userId, archivedAt: null },
      include: WITH_PROFILE,
    });
    if (!vehicle) {
      throw notFound();
    }
    return vehicle;
  }

  async get(userId: string, vehicleId: string): Promise<VehicleDto> {
    return toVehicleDto(await this.find(userId, vehicleId));
  }

  async create(userId: string, input: VehicleInput): Promise<VehicleDto> {
    this.assertValid(input);
    const limit = VEHICLE_LIMITS[await this.usage.planOf(userId)];
    const now = this.clock.now();

    const vehicle = await this.database.client.$transaction(async (tx) => {
      await this.lockUser(tx, userId);
      const active = await tx.vehicle.findMany({
        where: { userId, archivedAt: null },
        select: { isDefault: true },
      });
      if (active.length >= limit) {
        throw new AppError(
          409,
          'VEHICLE_LIMIT_REACHED',
          'Tu plan no admite mas vehiculos; archiva uno para registrar otro',
        );
      }
      // Siempre hay un predeterminado: el primero lo es aunque no se pida.
      const isDefault = input.isDefault === true || !active.some((other) => other.isDefault);
      if (isDefault) {
        await this.clearDefault(tx, userId);
      }
      return tx.vehicle.create({
        data: {
          userId,
          ...this.vehicleFields(input),
          isDefault,
          createdAt: now,
          updatedAt: now,
          vehicleCostProfiles: {
            create: {
              ...this.profileFields(input),
              createdAt: now,
              updatedAt: now,
              maintenanceItems: { create: this.maintenanceItems(input, now) },
            },
          },
        },
        include: WITH_PROFILE,
      });
    });
    await this.analytics.record({
      name: 'vehicle_setup_completed',
      userId,
      properties: {
        vehicle_type: input.type,
        has_maintenance_items: input.costProfile.maintenanceItems.length > 0,
        has_fixed_costs: Fraction.parse(input.costProfile.monthlyFixedCost).sign() > 0,
      },
    });
    return toVehicleDto(vehicle);
  }

  /** Reemplazo completo. Las cotizaciones guardadas no cambian: llevan su propio snapshot. */
  async replace(userId: string, vehicleId: string, input: VehicleInput): Promise<VehicleDto> {
    this.assertValid(input);
    const now = this.clock.now();

    const vehicle = await this.database.client.$transaction(async (tx) => {
      await this.lockUser(tx, userId);
      const current = await tx.vehicle.findFirst({
        where: { id: vehicleId, userId, archivedAt: null },
        include: { vehicleCostProfiles: { where: { isActive: true } } },
      });
      const profile = current?.vehicleCostProfiles[0];
      if (!current || !profile) {
        throw notFound();
      }
      // Un predeterminado solo deja de serlo cuando otro pasa a serlo.
      const isDefault = input.isDefault === true || current.isDefault;
      if (isDefault && !current.isDefault) {
        await this.clearDefault(tx, userId);
      }
      await tx.maintenanceItem.deleteMany({ where: { costProfileId: profile.id } });
      await tx.vehicleCostProfile.update({
        where: { id: profile.id },
        data: {
          ...this.profileFields(input),
          updatedAt: now,
          maintenanceItems: { create: this.maintenanceItems(input, now) },
        },
      });
      return tx.vehicle.update({
        where: { id: current.id },
        data: {
          ...this.vehicleFields(input),
          brand: input.brand ?? null,
          model: input.model ?? null,
          year: input.year ?? null,
          isDefault,
          updatedAt: now,
        },
        include: WITH_PROFILE,
      });
    });
    return toVehicleDto(vehicle);
  }

  /** No hay borrado fisico: las cotizaciones guardadas referencian al vehiculo. */
  async archive(userId: string, vehicleId: string): Promise<void> {
    const now = this.clock.now();
    await this.database.client.$transaction(async (tx) => {
      await this.lockUser(tx, userId);
      const current = await tx.vehicle.findFirst({
        where: { id: vehicleId, userId, archivedAt: null },
      });
      if (!current) {
        throw notFound();
      }
      await tx.vehicle.update({
        where: { id: current.id },
        data: { archivedAt: now, isDefault: false, updatedAt: now },
      });
      if (current.isDefault) {
        const next = await tx.vehicle.findFirst({
          where: { userId, archivedAt: null },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        });
        if (next) {
          await tx.vehicle.update({ where: { id: next.id }, data: { isDefault: true } });
        }
      }
    });
  }

  private assertValid(input: VehicleInput): void {
    const errors = validateVehicle(input);
    if (errors.length > 0) {
      throw new AppError(422, 'VALIDATION_FAILED', 'La peticion no es valida', { errors });
    }
  }

  /**
   * Serializa los cambios de vehiculos de un mismo usuario durante la transaccion: sin esto, dos
   * creaciones simultaneas contarian cero vehiculos cada una y ambas pasarian el limite del plan.
   */
  private async lockUser(tx: Tx, userId: string): Promise<void> {
    // $executeRaw y no $queryRaw: la funcion devuelve void, que Prisma no sabe leer como fila.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`vehicles:${userId}`}))`;
  }

  private async clearDefault(tx: Tx, userId: string): Promise<void> {
    await tx.vehicle.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
  }

  private vehicleFields(input: VehicleInput) {
    return {
      type: input.type,
      brand: input.brand,
      model: input.model,
      year: input.year,
      fuelType: input.fuelType,
      fuelEfficiencyKmPerGallon: input.fuelEfficiencyKmPerGallon,
      currentValue: input.currentValue,
      expectedResidualValue: input.expectedResidualValue,
      remainingUsefulLifeKm: input.remainingUsefulLifeKm ?? null,
    };
  }

  private profileFields(input: VehicleInput) {
    const profile = input.costProfile;
    return {
      fuelPricePerGallon: profile.fuelPricePerGallon,
      tireSetCost: profile.tireSetCost,
      tireUsefulLifeKm: profile.tireUsefulLifeKm ?? null,
      monthlyFixedCost: profile.monthlyFixedCost,
      expectedMonthlyKm: profile.expectedMonthlyKm ?? null,
      targetHourlyIncome: profile.targetHourlyIncome,
      platformCommissionRate: profile.platformCommissionRate,
      paymentPercentageRate: profile.paymentPercentageRate,
      paymentFixedFee: profile.paymentFixedFee,
      targetProfitMargin: profile.targetProfitMargin,
    };
  }

  /** La tabla no tiene columna de orden: la hora de creacion, desplazada un milisegundo por item, lo conserva. */
  private maintenanceItems(input: VehicleInput, now: Date) {
    return input.costProfile.maintenanceItems.map((item, index) => ({
      name: item.name,
      cost: item.cost,
      intervalKm: item.intervalKm,
      enabled: item.enabled,
      createdAt: new Date(now.getTime() + index),
      updatedAt: now,
    }));
  }
}
