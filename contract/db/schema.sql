-- TrayectoIQ MVP — PostgreSQL schema baseline (requiere PostgreSQL 16+)
-- Canonical financial calculations live in ../03_PRICING_ENGINE.md
--
-- Convenciones:
--   * Un CHECK pasa cuando su expresion es NULL. Toda regla "si A entonces B > 0"
--     sobre una columna nullable se escribe con IS NOT NULL explicito.
--   * Valores raw: numeric(24,10) (10 decimales, ver 03_PRICING_ENGINE.md seccion 2.2).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('USER','SUPPORT','ADMIN');
CREATE TYPE oauth_provider AS ENUM ('GOOGLE','APPLE');
CREATE TYPE vehicle_type AS ENUM ('MOTORCYCLE','CAR');
CREATE TYPE fuel_type AS ENUM ('GASOLINE','DIESEL','HYBRID');
CREATE TYPE quote_decision_recommendation AS ENUM ('ACCEPT','NEGOTIATE','REJECT');
CREATE TYPE real_decision_action AS ENUM (
  'ACCEPTED_ORIGINAL_OFFER',
  'NEGOTIATED_AND_ACCEPTED',
  'REJECTED',
  'CANCELLED_BY_OTHER_PARTY',
  'UNKNOWN'
);
CREATE TYPE influence_answer AS ENUM ('YES','NO','UNSURE');
CREATE TYPE subscription_provider AS ENUM ('APPLE','GOOGLE');
-- El trial es una cuota de previews (quote_usage_counters), no un estado de tienda.
CREATE TYPE subscription_status AS ENUM ('ACTIVE','GRACE','CANCELLED','EXPIRED','REFUNDED');
CREATE TYPE data_export_status AS ENUM ('PENDING','PROCESSING','READY','FAILED','EXPIRED');

-- ---------------------------------------------------------------------------
-- Identidad y sesiones
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  -- NULL hasta verificar. Los logins OAuth con email verificado por el proveedor lo fijan al crear.
  email_verified_at timestamptz,
  password_hash text,
  display_name text,
  role user_role NOT NULL DEFAULT 'USER',
  country_code char(2) NOT NULL DEFAULT 'EC' CHECK (country_code = 'EC'),
  currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  timezone text NOT NULL DEFAULT 'America/Guayaquil',
  analytics_opt_out boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','DELETED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX users_email_unique_ci ON users ((lower(email))) WHERE deleted_at IS NULL;

CREATE TABLE oauth_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider oauth_provider NOT NULL,
  provider_subject text NOT NULL,
  email_at_provider text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_subject)
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,
  -- Hash del refresh token anterior: si se presenta fuera de la ventana de gracia, es reuso -> revocar la sesion.
  previous_refresh_token_hash text UNIQUE,
  rotated_at timestamptz,
  device_label text,
  platform text CHECK (platform IN ('IOS','ANDROID','WEB','UNKNOWN')),
  app_version text,
  ip_hash text,
  user_agent_hash text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);

CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_verification_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_verification_codes_user_idx ON email_verification_codes(user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Vehiculos y costos
-- ---------------------------------------------------------------------------

CREATE TABLE vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type vehicle_type NOT NULL,
  brand text,
  model text,
  year int CHECK (year IS NULL OR year BETWEEN 1950 AND 2100),
  fuel_type fuel_type NOT NULL,
  fuel_efficiency_km_per_gallon numeric(18,6) NOT NULL CHECK (fuel_efficiency_km_per_gallon > 0),
  current_value numeric(18,6) NOT NULL DEFAULT 0 CHECK (current_value >= 0),
  expected_residual_value numeric(18,6) NOT NULL DEFAULT 0 CHECK (expected_residual_value >= 0),
  remaining_useful_life_km numeric(18,6),
  -- is_default: vehiculo preseleccionado al cotizar. archived_at: "eliminado" por el usuario.
  -- Un vehiculo con cotizaciones guardadas nunca se borra fisicamente.
  is_default boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    current_value <= expected_residual_value
    OR (remaining_useful_life_km IS NOT NULL AND remaining_useful_life_km > 0)
  ),
  CHECK (NOT (is_default AND archived_at IS NOT NULL))
);
CREATE INDEX vehicles_user_idx ON vehicles(user_id);
CREATE UNIQUE INDEX one_default_vehicle_per_user ON vehicles(user_id) WHERE is_default;

CREATE TABLE vehicle_cost_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  fuel_price_per_gallon numeric(18,6) NOT NULL DEFAULT 0 CHECK (fuel_price_per_gallon >= 0),
  tire_set_cost numeric(18,6) NOT NULL DEFAULT 0 CHECK (tire_set_cost >= 0),
  tire_useful_life_km numeric(18,6),
  monthly_fixed_cost numeric(18,6) NOT NULL DEFAULT 0 CHECK (monthly_fixed_cost >= 0),
  expected_monthly_km numeric(18,6),
  target_hourly_income numeric(18,6) NOT NULL DEFAULT 0 CHECK (target_hourly_income >= 0),
  platform_commission_rate numeric(9,6) NOT NULL DEFAULT 0 CHECK (platform_commission_rate >= 0 AND platform_commission_rate < 1),
  payment_percentage_rate numeric(9,6) NOT NULL DEFAULT 0 CHECK (payment_percentage_rate >= 0 AND payment_percentage_rate < 1),
  payment_fixed_fee numeric(18,6) NOT NULL DEFAULT 0 CHECK (payment_fixed_fee >= 0),
  target_profit_margin numeric(9,6) NOT NULL DEFAULT 0 CHECK (target_profit_margin >= 0 AND target_profit_margin < 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (tire_set_cost = 0 OR (tire_useful_life_km IS NOT NULL AND tire_useful_life_km > 0)),
  CHECK (monthly_fixed_cost = 0 OR (expected_monthly_km IS NOT NULL AND expected_monthly_km > 0)),
  CHECK (platform_commission_rate + payment_percentage_rate + target_profit_margin < 0.90)
);
CREATE UNIQUE INDEX one_active_cost_profile_per_vehicle
  ON vehicle_cost_profiles(vehicle_id) WHERE is_active = true;

CREATE TABLE maintenance_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cost_profile_id uuid NOT NULL REFERENCES vehicle_cost_profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  cost numeric(18,6) NOT NULL CHECK (cost >= 0),
  interval_km numeric(18,6) NOT NULL CHECK (interval_km > 0),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX maintenance_items_profile_idx ON maintenance_items(cost_profile_id);

-- ---------------------------------------------------------------------------
-- Cotizaciones
-- ---------------------------------------------------------------------------

CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  -- Id del preview del que nace la cotizacion: correlaciona con analytics e impide guardar dos veces el mismo preview.
  quote_request_id uuid NOT NULL UNIQUE,
  pricing_engine_version text NOT NULL,
  routing_provider text NOT NULL,
  routing_profile text NOT NULL,
  return_mode text NOT NULL DEFAULT 'SYMMETRIC_ESTIMATE' CHECK (return_mode = 'SYMMETRIC_ESTIMATE'),
  currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),

  -- Snapshot inmutable de todo lo que el motor uso ademas de la ruta:
  -- { "vehicleCostProfile": {...}, "engineConfig": {"thresholdStep","recommendedStep","returnMode"} }
  -- con la misma forma que fixtures/pricing-engine-golden.json. Permite reproducir la cotizacion
  -- aunque el usuario cambie o archive el vehiculo.
  pricing_input_snapshot jsonb NOT NULL,

  -- Exact location is privacy-sensitive and subject to retention policy (06_SECURITY_PRIVACY.md).
  pickup_lat numeric(10,7),
  pickup_lng numeric(10,7),
  destination_lat numeric(10,7),
  destination_lng numeric(10,7),
  pickup_label text,
  destination_label text,
  exact_location_expires_at timestamptz,

  pickup_distance_meters int NOT NULL DEFAULT 0 CHECK (pickup_distance_meters >= 0),
  pickup_duration_seconds int NOT NULL DEFAULT 0 CHECK (pickup_duration_seconds >= 0),
  trip_distance_meters int NOT NULL CHECK (trip_distance_meters > 0),
  trip_duration_seconds int NOT NULL CHECK (trip_duration_seconds > 0),
  waiting_seconds int NOT NULL DEFAULT 0 CHECK (waiting_seconds BETWEEN 0 AND 10800),
  empty_return_probability numeric(9,6) NOT NULL CHECK (empty_return_probability >= 0 AND empty_return_probability <= 1),

  offered_price numeric(18,6) CHECK (offered_price IS NULL OR offered_price >= 0),
  tolls_amount numeric(18,6) NOT NULL DEFAULT 0 CHECK (tolls_amount >= 0),
  parking_amount numeric(18,6) NOT NULL DEFAULT 0 CHECK (parking_amount >= 0),
  other_direct_cost_amount numeric(18,6) NOT NULL DEFAULT 0 CHECK (other_direct_cost_amount >= 0),

  operating_cost_raw numeric(24,10) NOT NULL,
  floor_price_raw numeric(24,10) NOT NULL,
  minimum_price_raw numeric(24,10) NOT NULL,
  recommended_price_raw numeric(24,10) NOT NULL,
  floor_price numeric(18,2) NOT NULL,
  minimum_price numeric(18,2) NOT NULL,
  recommended_price numeric(18,2) NOT NULL,
  earnings_per_hour_raw numeric(24,10),
  earnings_per_km_raw numeric(24,10),
  recommendation quote_decision_recommendation,

  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (minimum_price >= floor_price AND recommended_price >= minimum_price),
  CHECK ((offered_price IS NULL) = (recommendation IS NULL))
);
CREATE INDEX quotes_user_created_idx ON quotes(user_id, created_at DESC);
CREATE INDEX quotes_location_expiry_idx ON quotes(exact_location_expires_at) WHERE exact_location_expires_at IS NOT NULL;

CREATE TABLE quote_cost_breakdowns (
  quote_id uuid PRIMARY KEY REFERENCES quotes(id) ON DELETE CASCADE,
  fuel_cost numeric(24,10) NOT NULL,
  maintenance_cost numeric(24,10) NOT NULL,
  tire_cost numeric(24,10) NOT NULL,
  depreciation_cost numeric(24,10) NOT NULL,
  fixed_cost numeric(24,10) NOT NULL,
  tolls_cost numeric(24,10) NOT NULL,
  parking_cost numeric(24,10) NOT NULL,
  other_cost numeric(24,10) NOT NULL,
  driver_target_compensation numeric(24,10) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quote_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL UNIQUE REFERENCES quotes(id) ON DELETE CASCADE,
  action real_decision_action NOT NULL,
  final_price numeric(18,6) CHECK (final_price IS NULL OR final_price >= 0),
  influence influence_answer NOT NULL,
  notes text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    action NOT IN ('ACCEPTED_ORIGINAL_OFFER','NEGOTIATED_AND_ACCEPTED')
    OR final_price IS NOT NULL
  )
);

-- Cuota de calculos de ruta. period_key = 'TRIAL' (acumulado de por vida) o 'YYYY-MM' (fair-use Pro, UTC).
-- Consumo atomico:
--   INSERT INTO quote_usage_counters (user_id, period_key, used)
--   SELECT :user, :period, 1 WHERE :limit > 0
--   ON CONFLICT (user_id, period_key) DO UPDATE SET used = quote_usage_counters.used + 1
--   WHERE quote_usage_counters.used < :limit RETURNING used;
-- Cero filas devueltas = cuota agotada. El "WHERE :limit > 0" del SELECT cubre la primera
-- peticion: sin el, un limite 0 concederia una unidad porque aun no hay fila que entre en conflicto.
CREATE TABLE quote_usage_counters (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_key text NOT NULL CHECK (period_key = 'TRIAL' OR period_key ~ '^[0-9]{4}-[0-9]{2}$'),
  used int NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period_key)
);

-- ---------------------------------------------------------------------------
-- Suscripciones
-- ---------------------------------------------------------------------------

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider subscription_provider NOT NULL,
  product_id text NOT NULL,
  provider_subscription_id text NOT NULL,
  status subscription_status NOT NULL,
  entitlement_active boolean NOT NULL DEFAULT false,
  starts_at timestamptz,
  current_period_end timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_subscription_id)
);
CREATE INDEX subscriptions_user_idx ON subscriptions(user_id);

CREATE TABLE subscription_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE CASCADE,
  provider subscription_provider NOT NULL,
  provider_transaction_id text NOT NULL,
  event_type text NOT NULL,
  raw_payload_hash text NOT NULL,
  occurred_at timestamptz NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_transaction_id, event_type)
);

-- Variante asignada a cada usuario en un experimento (p. ej. precio A/B del paywall).
CREATE TABLE experiment_assignments (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  experiment_key text NOT NULL,
  variant text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, experiment_key)
);

-- ---------------------------------------------------------------------------
-- Operacion
-- ---------------------------------------------------------------------------

CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_status int,
  response_body jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- NULLS NOT DISTINCT: sin esto, dos filas con user_id NULL (webhooks) no chocarian.
  UNIQUE NULLS NOT DISTINCT (user_id, scope, idempotency_key)
);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys(expires_at);

CREATE TABLE data_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status data_export_status NOT NULL DEFAULT 'PENDING',
  storage_key text,
  error_code text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz,
  CHECK (status <> 'READY' OR (storage_key IS NOT NULL AND expires_at IS NOT NULL))
);
CREATE INDEX data_exports_user_idx ON data_exports(user_id, requested_at DESC);

CREATE TABLE feature_flags (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  description text,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Claves esperadas: trial_quote_limit, pro_fair_use_monthly_limit, pricing_recommended_step,
-- min_ios_version, min_android_version, maintenance_mode, location_retention_days, cost_presets.
CREATE TABLE app_config (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SET NULL + actor_email conserva la traza aunque la cuenta del operador se elimine.
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_email text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  reason text,
  before_value jsonb,
  after_value jsonb,
  trace_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_created_idx ON admin_audit_logs(created_at DESC);

-- Eventos de producto (08_ANALYTICS_VALIDATION.md). Sin PII ni coordenadas en properties.
-- Al eliminar la cuenta, user_id pasa a NULL y la fila queda como dato agregado anonimo;
-- por eso no hay CHECK que exija user_id o anonymous_id.
CREATE TABLE analytics_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  anonymous_id text,
  event_name text NOT NULL,
  event_version int NOT NULL DEFAULT 1,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analytics_events_name_time_idx ON analytics_events(event_name, occurred_at);
CREATE INDEX analytics_events_user_time_idx ON analytics_events(user_id, occurred_at) WHERE user_id IS NOT NULL;
