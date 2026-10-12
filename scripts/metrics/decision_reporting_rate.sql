-- Decision Reporting Rate (08_ANALYTICS_VALIDATION.md seccion 4)
-- Parametros: $1 = inicio del periodo (inclusive), $2 = fin (exclusive).
-- Numerador: cotizaciones guardadas en el periodo con una decision real (no UNKNOWN) registrada
--            dentro de las 24 horas siguientes.
-- Denominador: cotizaciones guardadas en el periodo. Para que todas hayan tenido sus 24 horas,
--              el fin del periodo debe quedar al menos un dia atras.
WITH counts AS (
  SELECT
    count(*) FILTER (
      WHERE d.action IS NOT NULL
        AND d.action <> 'UNKNOWN'
        AND d.decided_at <= q.created_at + interval '24 hours'
    )::int AS n,
    count(*)::int AS d
  FROM quotes q
  LEFT JOIN quote_decisions d ON d.quote_id = q.id
  WHERE q.created_at >= $1::timestamptz AND q.created_at < $2::timestamptz
)
SELECT
  'decision_reporting_rate' AS metric,
  n AS numerator,
  d AS denominator,
  round(n::numeric / NULLIF(d, 0), 4) AS rate,
  round((n + 1.920729 - 1.959964 * sqrt(n::numeric * (d - n) / NULLIF(d, 0) + 0.960365)) / (d + 3.841459), 4) AS ci_low,
  round((n + 1.920729 + 1.959964 * sqrt(n::numeric * (d - n) / NULLIF(d, 0) + 0.960365)) / (d + 3.841459), 4) AS ci_high
FROM counts;
