-- Conversion a pago (08_ANALYTICS_VALIDATION.md seccion 4)
-- Parametros: $1 = inicio del periodo (inclusive), $2 = fin (exclusive).
-- Denominador: usuarios que vieron el paywall en el periodo.
-- Numerador: de ellos, los que activaron una suscripcion desde su primer paywall del periodo.
WITH viewers AS (
  SELECT user_id, min(occurred_at) AS first_view
  FROM analytics_events
  WHERE event_name = 'paywall_viewed' AND user_id IS NOT NULL
    AND occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz
  GROUP BY user_id
), counts AS (
  SELECT
    count(*) FILTER (
      WHERE EXISTS (
        SELECT 1 FROM analytics_events e
        WHERE e.user_id = v.user_id
          AND e.event_name = 'subscription_activated'
          AND e.occurred_at >= v.first_view
      )
    )::int AS n,
    count(*)::int AS d
  FROM viewers v
)
SELECT
  'conversion_to_paid' AS metric,
  n AS numerator,
  d AS denominator,
  round(n::numeric / NULLIF(d, 0), 4) AS rate,
  round((n + 1.920729 - 1.959964 * sqrt(n::numeric * (d - n) / NULLIF(d, 0) + 0.960365)) / (d + 3.841459), 4) AS ci_low,
  round((n + 1.920729 + 1.959964 * sqrt(n::numeric * (d - n) / NULLIF(d, 0) + 0.960365)) / (d + 3.841459), 4) AS ci_high
FROM counts;
