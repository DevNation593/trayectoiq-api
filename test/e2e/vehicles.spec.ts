import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, registerUser, type Session } from '../support/api.js';
import { fixture, invalid, setPath } from '../support/pricing-fixtures.js';
import { createTestApp, type TestApp } from '../support/test-app.js';
import {
  createVehicle,
  idempotencyKey,
  postVehicle,
  type VehicleBody,
  vehicleFromFixture,
  type VehicleResponse,
} from '../support/vehicles.js';

describe('vehiculos y perfil de costos', () => {
  let test: TestApp;
  let db: pg.Pool;

  const makePro = async (session: Session): Promise<void> => {
    await db.query(
      `INSERT INTO subscriptions (user_id, provider, product_id, provider_subscription_id, status, entitlement_active)
       VALUES ($1, 'GOOGLE', 'pro_monthly', $2, 'ACTIVE', true)`,
      [session.userId, `sub-${session.userId}`],
    );
  };
  const list = (session: Session) =>
    call<VehicleResponse[]>(test, 'listVehicles', { token: session.accessToken });

  beforeAll(async () => {
    test = await createTestApp();
    db = new pg.Pool({ connectionString: test.database.url, max: 2 });
  });
  afterAll(async () => {
    await db?.end();
    await test?.close();
  });

  describe('crear y leer', () => {
    it('crea el vehiculo con su perfil de costos y lo devuelve con id', async () => {
      const session = await registerUser(test);
      const body: VehicleBody = {
        ...vehicleFromFixture(),
        brand: 'Honda',
        model: 'CB190',
        year: 2022,
      };

      const { status, body: created } = await postVehicle(test, session, body);

      expect(status).toBe(201);
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created).toMatchObject({
        type: 'MOTORCYCLE',
        brand: 'Honda',
        model: 'CB190',
        year: 2022,
        fuelType: 'GASOLINE',
        fuelEfficiencyKmPerGallon: '110',
        currentValue: '3200',
        expectedResidualValue: '800',
        remainingUsefulLifeKm: '60000',
      });
      expect(created.costProfile).toMatchObject({
        fuelPricePerGallon: '2.75',
        tireSetCost: '180',
        tireUsefulLifeKm: '30000',
        monthlyFixedCost: '60',
        expectedMonthlyKm: '2000',
        targetHourlyIncome: '4.5',
        platformCommissionRate: '0.1',
        paymentPercentageRate: '0',
        paymentFixedFee: '0',
        targetProfitMargin: '0.1',
      });
      expect(created.costProfile.maintenanceItems).toEqual([
        { name: 'Oil', cost: '25', intervalKm: '3000', enabled: true },
        { name: 'Chain', cost: '60', intervalKm: '25000', enabled: true },
      ]);
    });

    it('el primer vehiculo queda como predeterminado', async () => {
      const session = await registerUser(test);
      expect((await createVehicle(test, session)).isDefault).toBe(true);
    });

    it('aparece en la lista y se puede leer por id', async () => {
      const session = await registerUser(test);
      const created = await createVehicle(test, session);

      const listed = await list(session);
      expect(listed.status).toBe(200);
      expect(listed.body.map((vehicle) => vehicle.id)).toEqual([created.id]);

      const fetched = await call<VehicleResponse>(test, 'getVehicle', {
        token: session.accessToken,
        params: { vehicleId: created.id },
      });
      expect(fetched.status).toBe(200);
      expect(fetched.body).toEqual(created);
    });

    it('un correo sin verificar puede registrar su vehiculo', async () => {
      const session = await registerUser(test, { verified: false });
      expect((await postVehicle(test, session)).status).toBe(201);
    });

    it('la misma Idempotency-Key no crea dos vehiculos', async () => {
      const session = await registerUser(test);
      const headers = idempotencyKey();
      const first = await postVehicle(test, session, vehicleFromFixture(), headers);
      const second = await postVehicle(test, session, vehicleFromFixture(), headers);

      expect(second.status).toBe(201);
      expect(second.body.id).toBe(first.body.id);
      expect((await list(session)).body).toHaveLength(1);
    });

    it('sin Idempotency-Key es 422', async () => {
      const session = await registerUser(test);
      expect((await postVehicle(test, session, vehicleFromFixture(), {})).status).toBe(422);
    });
  });

  describe('limite por plan', () => {
    it('en trial, el segundo vehiculo es 409 VEHICLE_LIMIT_REACHED', async () => {
      const session = await registerUser(test);
      await createVehicle(test, session);

      const second = await postVehicle(test, session);

      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ code: 'VEHICLE_LIMIT_REACHED' });
    });

    it('archivar libera el cupo y saca el vehiculo de la lista', async () => {
      const session = await registerUser(test);
      const first = await createVehicle(test, session);

      const archived = await call(test, 'archiveVehicle', {
        token: session.accessToken,
        params: { vehicleId: first.id },
      });
      expect(archived.status).toBe(204);
      expect((await list(session)).body).toEqual([]);
      const gone = await call(test, 'getVehicle', {
        token: session.accessToken,
        params: { vehicleId: first.id },
      });
      expect(gone.status).toBe(404);

      const replacement = await createVehicle(test, session);
      expect(replacement.id).not.toBe(first.id);
      expect(replacement.isDefault).toBe(true);
    });

    it('archivar dos veces es 404 la segunda', async () => {
      const session = await registerUser(test);
      const vehicle = await createVehicle(test, session);
      const params = { vehicleId: vehicle.id };
      await call(test, 'archiveVehicle', { token: session.accessToken, params });
      expect(
        (await call(test, 'archiveVehicle', { token: session.accessToken, params })).status,
      ).toBe(404);
    });

    it('cinco creaciones simultaneas en trial dejan exactamente un vehiculo', async () => {
      const session = await registerUser(test);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => postVehicle(test, session)),
      );

      expect(results.filter((result) => result.status === 201)).toHaveLength(1);
      expect(results.filter((result) => result.status === 409)).toHaveLength(4);
      expect((await list(session)).body).toHaveLength(1);
    });

    it('Pro admite hasta 5 vehiculos', async () => {
      const session = await registerUser(test);
      await makePro(session);
      for (let index = 0; index < 5; index += 1) {
        await createVehicle(test, session);
      }
      const sixth = await postVehicle(test, session);
      expect(sixth.status).toBe(409);
      expect(sixth.body).toMatchObject({ code: 'VEHICLE_LIMIT_REACHED' });
    });
  });

  describe('predeterminado', () => {
    it('marcar otro como predeterminado desmarca el anterior; la lista lo pone primero', async () => {
      const session = await registerUser(test);
      await makePro(session);
      const first = await createVehicle(test, session);
      const second = await createVehicle(test, session, {
        ...vehicleFromFixture(),
        isDefault: true,
      });

      const listed = (await list(session)).body;
      expect(listed.map((vehicle) => [vehicle.id, vehicle.isDefault])).toEqual([
        [second.id, true],
        [first.id, false],
      ]);
    });

    it('al archivar el predeterminado, otro vehiculo pasa a serlo', async () => {
      const session = await registerUser(test);
      await makePro(session);
      const first = await createVehicle(test, session);
      const second = await createVehicle(test, session);

      await call(test, 'archiveVehicle', {
        token: session.accessToken,
        params: { vehicleId: first.id },
      });

      expect((await list(session)).body).toMatchObject([{ id: second.id, isDefault: true }]);
    });
  });

  describe('reemplazar', () => {
    it('PUT reemplaza el vehiculo y todo su perfil, incluidos los mantenimientos', async () => {
      const session = await registerUser(test);
      const created = await createVehicle(test, session);
      const replacement = vehicleFromFixture('C_car_fixed_fee_accept');

      const updated = await call<VehicleResponse>(test, 'updateVehicle', {
        token: session.accessToken,
        params: { vehicleId: created.id },
        body: replacement,
      });

      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({
        id: created.id,
        type: 'CAR',
        fuelEfficiencyKmPerGallon: '45',
        isDefault: true,
      });
      expect(updated.body.costProfile).toMatchObject({
        paymentPercentageRate: '0.02',
        paymentFixedFee: '0.1',
        targetProfitMargin: '0.08',
      });
      expect(updated.body.costProfile.maintenanceItems.map((item) => item.name)).toEqual([
        'Oil',
        'Brakes',
      ]);
      const fetched = await call<VehicleResponse>(test, 'getVehicle', {
        token: session.accessToken,
        params: { vehicleId: created.id },
      });
      expect(fetched.body).toEqual(updated.body);
    });

    it('PUT de un vehiculo inexistente es 404', async () => {
      const session = await registerUser(test);
      const { status } = await call(test, 'updateVehicle', {
        token: session.accessToken,
        params: { vehicleId: '0b0e2a52-7d0c-4f5c-9a43-0f3f3a8d2f10' },
        body: vehicleFromFixture(),
      });
      expect(status).toBe(404);
    });
  });

  describe('reglas del perfil de costos (las mismas del Pricing Engine)', () => {
    const rejects = async (mutate: (body: VehicleBody) => void, field: string): Promise<void> => {
      const session = await registerUser(test);
      const body = vehicleFromFixture();
      mutate(body);
      const { status, body: problem } = await postVehicle(test, session, body);
      expect(status, JSON.stringify(problem)).toBe(422);
      expect(problem).toMatchObject({ code: 'VALIDATION_FAILED' });
      const errors = (problem as unknown as { errors: { field: string }[] }).errors;
      expect(errors.map((error) => error.field)).toContain(field);
    };

    it('costo fijo mensual sin kilometraje mensual', () =>
      rejects((body) => {
        body.costProfile.expectedMonthlyKm = null;
      }, 'costProfile.expectedMonthlyKm'));

    it('rendimiento de combustible en cero', () =>
      rejects((body) => {
        body.fuelEfficiencyKmPerGallon = '0';
      }, 'fuelEfficiencyKmPerGallon'));

    it('costo de neumaticos sin vida util', () =>
      rejects((body) => {
        body.costProfile.tireUsefulLifeKm = null;
      }, 'costProfile.tireUsefulLifeKm'));

    it('depreciacion positiva sin vida util restante', () =>
      rejects((body) => {
        body.remainingUsefulLifeKm = null;
      }, 'remainingUsefulLifeKm'));

    it('mantenimiento habilitado con intervalo cero', () =>
      rejects((body) => {
        body.costProfile.maintenanceItems[1]!.intervalKm = '0';
      }, 'costProfile.maintenanceItems[1].intervalKm'));

    it('mantenimiento deshabilitado con intervalo cero (la base exige intervalo positivo siempre)', () =>
      rejects((body) => {
        body.costProfile.maintenanceItems[0] = {
          name: 'Deshabilitado',
          cost: '10',
          intervalKm: '0',
          enabled: false,
        };
      }, 'costProfile.maintenanceItems[0].intervalKm'));

    it('comisiones mas margen en 0.90 o mas', () =>
      rejects((body) => {
        body.costProfile.platformCommissionRate = '0.5';
        body.costProfile.targetProfitMargin = '0.4';
      }, 'costProfile.targetProfitMargin'));

    it('acepta divisores ausentes cuando su costo es cero', async () => {
      const session = await registerUser(test);
      const body = vehicleFromFixture();
      body.currentValue = '800';
      body.remainingUsefulLifeKm = null;
      body.costProfile.tireSetCost = '0';
      body.costProfile.tireUsefulLifeKm = null;
      body.costProfile.monthlyFixedCost = '0';
      body.costProfile.expectedMonthlyKm = null;
      body.costProfile.maintenanceItems = [];
      expect((await postVehicle(test, session, body)).status).toBe(201);
    });

    it('ningun perfil que el Pricing Engine rechazaria se puede guardar', async () => {
      const session = await registerUser(test);
      const profileCases = invalid.invalidFixtures.filter((candidate) =>
        Object.keys(candidate.overrides).every((path) => path.startsWith('vehicleCostProfile.')),
      );
      expect(profileCases.length).toBeGreaterThanOrEqual(8);

      for (const candidate of profileCases) {
        const input = structuredClone(fixture(invalid.baseFixture));
        for (const [path, value] of Object.entries(candidate.overrides)) {
          setPath(input, path, value);
        }
        const profile = input.vehicleCostProfile;
        const body = vehicleFromFixture();
        body.fuelEfficiencyKmPerGallon = profile.fuelEfficiencyKmPerGallon as string;
        body.remainingUsefulLifeKm = profile.remainingUsefulLifeKm;
        Object.assign(body.costProfile, {
          tireUsefulLifeKm: profile.tireUsefulLifeKm,
          expectedMonthlyKm: profile.expectedMonthlyKm,
          platformCommissionRate: profile.platformCommissionRate,
          targetProfitMargin: profile.targetProfitMargin,
          maintenanceItems: profile.maintenanceItems,
        });

        const { status } = await postVehicle(test, session, body);
        expect(status, candidate.name).toBe(422);
      }
      expect((await list(session)).body).toEqual([]);
    });
  });

  describe('aislamiento entre usuarios', () => {
    it('el vehiculo de otra persona no se puede leer, reemplazar ni archivar: siempre 404', async () => {
      const owner = await registerUser(test);
      const intruder = await registerUser(test);
      const vehicle = await createVehicle(test, owner);
      const params = { vehicleId: vehicle.id };
      const token = intruder.accessToken;

      expect((await call(test, 'getVehicle', { token, params })).status).toBe(404);
      expect(
        (await call(test, 'updateVehicle', { token, params, body: vehicleFromFixture() })).status,
      ).toBe(404);
      expect((await call(test, 'archiveVehicle', { token, params })).status).toBe(404);

      expect((await list(intruder)).body).toEqual([]);
      expect((await list(owner)).body).toHaveLength(1);
    });

    it('todas las operaciones exigen sesion', async () => {
      const params = { vehicleId: '0b0e2a52-7d0c-4f5c-9a43-0f3f3a8d2f10' };
      expect((await call(test, 'listVehicles')).status).toBe(401);
      expect((await call(test, 'getVehicle', { params })).status).toBe(401);
      expect((await call(test, 'archiveVehicle', { params })).status).toBe(401);
    });
  });
});
