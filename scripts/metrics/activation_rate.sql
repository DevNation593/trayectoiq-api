-- Activation Rate (08_ANALYTICS_VALIDATION.md seccion 4)
-- Parametros: $1 = inicio del periodo (inclusive), $2 = fin (exclusive).
-- Numerador: usuarios registrados en el periodo que configuraron un vehiculo y obtuvieron al menos
--            un preview correcto (en cualquier momento).
-- Denominador: usuarios registrados en el periodo.
-- Se apoya en eventos: un usuario que desactivo analytics no aparece como activado.
WITH counts AS (
  SELECT
    count(*) FILTER (
      WHERE EXISTS (
        SELECT 1 FROM analytics_events e
        WHERE e.user_id = u.id AND e.event_name = 'vehicle_setup_completed'
      ) AND EXISTS (
        SELECT 1 FROM analytics_events e
        WHERE e.user_id = u.id AND e.event_name = 'quote_preview_succeeded'
      )
    )::int AS n,
    count(*)::int AS d
  FROM users u
  WHERE u.created_at >= $1::timestamptz AND u.created_at < $2::timestamptz
)
SELECT
  'activation_rate' AS metric,
  n AS numerator,
  d AS denominator,
  round(n::numeric / NULLIF(d, 0), 4) AS rate,
  round((n + 1.920729 - 1.959964 * sqrt(n::numeric * (d - n) / NULLIF(d, 0) + 0.960365)) / (d + 3.841459), 4) AS ci_low,
  round((n + 1.920729 + 1.959964 * sqrt(n::numeric * (d - n) / NULLIF(d, 0) + 0.960365)) / (d + 3.841459), 4) AS ci_high
FROM counts;
