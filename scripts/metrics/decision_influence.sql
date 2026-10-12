-- Decision Influence (08_ANALYTICS_VALIDATION.md seccion 4)
-- Parametros: $1 = inicio del periodo (inclusive), $2 = fin (exclusive).
-- Numerador: decisiones en que el usuario dijo que la recomendacion influyo (YES).
-- Denominador: decisiones sobre cotizaciones guardadas en el periodo (YES, NO o UNSURE).
-- Es autodeclarada: no se presenta como causalidad.
WITH counts AS (
  SELECT
    count(*) FILTER (WHERE d.influence = 'YES')::int AS n,
    count(*)::int AS d
  FROM quote_decisions d
  JOIN quotes q ON q.id = d.quote_id
  WHERE q.created_at >= $1::timestamptz AND q.created_at < $2::timestamptz
)
SELECT
  'decision_influence' AS metric,
  n AS numerator,
  d AS denominator,
  round(n::numeric / NULLIF(d, 0), 4) AS rate,
  round((n + 1.920729 - 1.959964 * sqrt(n::numeric * (d - n) / NULLIF(d, 0) + 0.960365)) / (d + 3.841459), 4) AS ci_low,
  round((n + 1.920729 + 1.959964 * sqrt(n::numeric * (d - n) / NULLIF(d, 0) + 0.960365)) / (d + 3.841459), 4) AS ci_high
FROM counts;
