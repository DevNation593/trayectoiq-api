import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type TempDatabase } from '../support/temp-database.js';

/**
 * Invariantes que el modelo debe sostener en la base, sin depender del codigo de la API.
 * Cubren los defectos encontrados en la auditoria del esquema: CHECK que pasaban con NULL,
 * eliminacion de cuenta bloqueada por analytics y consumo de cuota bajo concurrencia.
 */

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

describe('invariantes del esquema', () => {
  let database: TempDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    database = await createMigratedDatabase('constraints');
    pool = new pg.Pool({ connectionString: database.url, max: 20 });
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  let counter = 0;
  async function createUser(email = `user${++counter}@example.com`): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO users (email) VALUES ($1) RETURNING id',
      [email],
    );
    return rows[0]!.id;
  }

  async function createVehicle(userId: string, isDefault = false): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO vehicles (user_id, type, fuel_type, fuel_efficiency_km_per_gallon, is_default)
       VALUES ($1, 'MOTORCYCLE', 'GASOLINE', 110, $2) RETURNING id`,
      [userId, isDefault],
    );
    return rows[0]!.id;
  }

  const expectCode = async (query: Promise<unknown>, code: string): Promise<void> => {
    await expect(query).rejects.toMatchObject({ code });
  };

  describe('divisores obligatorios (un CHECK no debe pasar con NULL)', () => {
    it('rechaza un vehiculo sin rendimiento de combustible', async () => {
      const userId = await createUser();
      await expect(
        pool.query(
          `INSERT INTO vehicles (user_id, type, fuel_type) VALUES ($1, 'CAR', 'GASOLINE')`,
          [userId],
        ),
      ).rejects.toMatchObject({ code: '23502' }); // NOT NULL
    });

    it('rechaza depreciacion positiva sin vida util restante', async () => {
      const userId = await createUser();
      await expectCode(
        pool.query(
          `INSERT INTO vehicles (user_id, type, fuel_type, fuel_efficiency_km_per_gallon,
                                 current_value, expected_residual_value, remaining_useful_life_km)
           VALUES ($1, 'CAR', 'GASOLINE', 45, 9000, 3000, NULL)`,
          [userId],
        ),
        CHECK_VIOLATION,
      );
    });

    it('acepta vida util NULL cuando no hay depreciacion', async () => {
      const userId = await createUser();
      await expect(createVehicle(userId)).resolves.toMatch(/^[0-9a-f-]{36}$/);
    });

    it('rechaza costo de neumaticos sin vida util', async () => {
      const vehicleId = await createVehicle(await createUser());
      await expectCode(
        pool.query(
          `INSERT INTO vehicle_cost_profiles (vehicle_id, tire_set_cost, tire_useful_life_km)
           VALUES ($1, 180, NULL)`,
          [vehicleId],
        ),
        CHECK_VIOLATION,
      );
    });

    it('rechaza costo fijo mensual sin kilometraje mensual', async () => {
      const vehicleId = await createVehicle(await createUser());
      await expectCode(
        pool.query(
          `INSERT INTO vehicle_cost_profiles (vehicle_id, monthly_fixed_cost, expected_monthly_km)
           VALUES ($1, 60, NULL)`,
          [vehicleId],
        ),
        CHECK_VIOLATION,
      );
    });

    it('rechaza un mantenimiento con intervalo cero', async () => {
      const vehicleId = await createVehicle(await createUser());
      const profile = await pool.query<{ id: string }>(
        'INSERT INTO vehicle_cost_profiles (vehicle_id) VALUES ($1) RETURNING id',
        [vehicleId],
      );
      await expectCode(
        pool.query(
          `INSERT INTO maintenance_items (cost_profile_id, name, cost, interval_km)
           VALUES ($1, 'Oil', 25, 0)`,
          [profile.rows[0]!.id],
        ),
        CHECK_VIOLATION,
      );
    });
  });

  describe('tasas', () => {
    it('rechaza comisiones mas margen en 0.90 y acepta 0.89', async () => {
      const first = await createVehicle(await createUser());
      await expectCode(
        pool.query(
          `INSERT INTO vehicle_cost_profiles (vehicle_id, platform_commission_rate, target_profit_margin)
           VALUES ($1, 0.50, 0.40)`,
          [first],
        ),
        CHECK_VIOLATION,
      );
      const second = await createVehicle(await createUser());
      await expect(
        pool.query(
          `INSERT INTO vehicle_cost_profiles (vehicle_id, platform_commission_rate, target_profit_margin)
           VALUES ($1, 0.50, 0.39)`,
          [second],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    });
  });

  describe('unicidad', () => {
    it('el email es unico sin distinguir mayusculas y queda libre al eliminar la cuenta', async () => {
      const userId = await createUser('Persona@Example.com');
      await expectCode(createUser('persona@example.com'), UNIQUE_VIOLATION);
      await pool.query(`UPDATE users SET status = 'DELETED', deleted_at = now() WHERE id = $1`, [
        userId,
      ]);
      await expect(createUser('persona@example.com')).resolves.toBeTypeOf('string');
    });

    it('solo un vehiculo predeterminado por usuario', async () => {
      const userId = await createUser();
      await createVehicle(userId, true);
      await expectCode(createVehicle(userId, true), UNIQUE_VIOLATION);
    });

    it('un vehiculo archivado no puede ser el predeterminado', async () => {
      const userId = await createUser();
      const vehicleId = await createVehicle(userId, true);
      await expectCode(
        pool.query('UPDATE vehicles SET archived_at = now() WHERE id = $1', [vehicleId]),
        CHECK_VIOLATION,
      );
    });

    it('la clave de idempotencia es unica tambien sin usuario (webhooks)', async () => {
      const insert = (): Promise<unknown> =>
        pool.query(
          `INSERT INTO idempotency_keys (user_id, scope, idempotency_key, request_hash, expires_at)
           VALUES (NULL, 'webhook:google', 'message-1', 'hash', now() + interval '1 day')`,
        );
      await insert();
      await expectCode(insert(), UNIQUE_VIOLATION);
    });
  });

  describe('eliminacion de cuenta', () => {
    it('borra en cascada los datos personales y conserva los eventos sin identificador', async () => {
      const userId = await createUser();
      const vehicleId = await createVehicle(userId);
      await pool.query(
        `INSERT INTO analytics_events (user_id, anonymous_id, event_name, occurred_at)
         VALUES ($1, NULL, 'app_opened', now())`,
        [userId],
      );
      await pool.query(
        `INSERT INTO quote_usage_counters (user_id, period_key, used) VALUES ($1, 'TRIAL', 3)`,
        [userId],
      );

      await pool.query('DELETE FROM users WHERE id = $1', [userId]);

      const vehicles = await pool.query('SELECT 1 FROM vehicles WHERE id = $1', [vehicleId]);
      const counters = await pool.query('SELECT 1 FROM quote_usage_counters WHERE user_id = $1', [
        userId,
      ]);
      const events = await pool.query(
        `SELECT user_id FROM analytics_events WHERE event_name = 'app_opened' AND user_id IS NULL`,
      );
      expect(vehicles.rowCount).toBe(0);
      expect(counters.rowCount).toBe(0);
      expect(events.rowCount).toBe(1);
    });

    it('un vehiculo con cotizaciones guardadas no se puede borrar fisicamente', async () => {
      const userId = await createUser();
      const vehicleId = await createVehicle(userId);
      await pool.query(
        `INSERT INTO quotes (user_id, vehicle_id, quote_request_id, pricing_engine_version,
                             routing_provider, routing_profile, pricing_input_snapshot,
                             trip_distance_meters, trip_duration_seconds, empty_return_probability,
                             operating_cost_raw, floor_price_raw, minimum_price_raw, recommended_price_raw,
                             floor_price, minimum_price, recommended_price)
         VALUES ($1, $2, gen_random_uuid(), '1.0.0', 'fake', 'motorcycle', '{}'::jsonb,
                 10000, 1800, 0, 1.1173333333, 1.2414814815, 3.7414814815, 4.2091666667,
                 1.25, 3.75, 4.25)`,
        [userId, vehicleId],
      );
      await expect(
        pool.query('DELETE FROM vehicles WHERE id = $1', [vehicleId]),
      ).rejects.toMatchObject({ code: '23503' }); // FOREIGN KEY
    });
  });

  describe('cuota atomica (sentencia documentada en schema.sql)', () => {
    const consume = (userId: string, limit: number): Promise<pg.QueryResult> =>
      pool.query(
        `INSERT INTO quote_usage_counters (user_id, period_key, used)
         SELECT $1, 'TRIAL', 1 WHERE $2 > 0
         ON CONFLICT (user_id, period_key) DO UPDATE SET used = quote_usage_counters.used + 1
         WHERE quote_usage_counters.used < $2 RETURNING used`,
        [userId, limit],
      );

    it('con limite 0 no concede ni la primera unidad', async () => {
      const userId = await createUser();
      expect((await consume(userId, 0)).rowCount).toBe(0);
      const { rowCount } = await pool.query(
        'SELECT 1 FROM quote_usage_counters WHERE user_id = $1',
        [userId],
      );
      expect(rowCount).toBe(0);
    });

    it('deja de conceder unidades al llegar al limite', async () => {
      const userId = await createUser();
      expect((await consume(userId, 2)).rowCount).toBe(1);
      expect((await consume(userId, 2)).rowCount).toBe(1);
      expect((await consume(userId, 2)).rowCount).toBe(0);
    });

    it('con 20 peticiones simultaneas y limite 5 concede exactamente 5', async () => {
      const userId = await createUser();
      const results = await Promise.all(Array.from({ length: 20 }, () => consume(userId, 5)));
      expect(results.filter((result) => result.rowCount === 1)).toHaveLength(5);
      const { rows } = await pool.query<{ used: number }>(
        'SELECT used FROM quote_usage_counters WHERE user_id = $1',
        [userId],
      );
      expect(rows[0]!.used).toBe(5);
    });
  });
});
