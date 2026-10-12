-- Calculos de ruta por dia activo (08_ANALYTICS_VALIDATION.md seccion 4)
-- Parametros: $1 = inicio del periodo (inclusive), $2 = fin (exclusive).
-- Por usuario: rutas nuevas (quote_preview_succeeded con route_reused = false) entre sus dias activos.
-- Un dia es activo si tiene un app_opened o un evento de cotizacion, en hora de America/Guayaquil.
-- Se reporta la mediana entre los usuarios activos del periodo; los recalculos no cuentan.
WITH days AS (
  SELECT
    user_id,
    (occurred_at AT TIME ZONE 'America/Guayaquil')::date AS day,
    count(*) FILTER (
      WHERE event_name = 'quote_preview_succeeded' AND properties->>'route_reused' = 'false'
    ) AS route_calculations
  FROM analytics_events
  WHERE user_id IS NOT NULL
    AND occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz
    AND event_name IN (
      'app_opened', 'quote_preview_requested', 'quote_preview_succeeded', 'quote_preview_failed',
      'quote_saved', 'quote_decision_recorded'
    )
  GROUP BY user_id, day
), sample AS (
  SELECT sum(route_calculations)::numeric / count(*) AS value
  FROM days
  GROUP BY user_id
)
SELECT
  'route_calculations_per_active_day' AS metric,
  count(*)::int AS sample_size,
  round((percentile_cont(0.5) WITHIN GROUP (ORDER BY value))::numeric, 4) AS median,
  round((percentile_cont(0.25) WITHIN GROUP (ORDER BY value))::numeric, 4) AS p25,
  round((percentile_cont(0.75) WITHIN GROUP (ORDER BY value))::numeric, 4) AS p75
FROM sample;
