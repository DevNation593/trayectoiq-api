-- Recommendation Gap (08_ANALYTICS_VALIDATION.md seccion 4)
-- Parametros: $1 = inicio del periodo (inclusive), $2 = fin (exclusive).
-- (precio final - precio recomendado) / precio recomendado, en toda decision con precio final.
-- No se usa como unica medida de exito.
WITH sample AS (
  SELECT (d.final_price - q.recommended_price) / q.recommended_price AS value
  FROM quote_decisions d
  JOIN quotes q ON q.id = d.quote_id
  WHERE q.created_at >= $1::timestamptz AND q.created_at < $2::timestamptz
    AND d.final_price IS NOT NULL
    AND q.recommended_price > 0
)
SELECT
  'recommendation_gap' AS metric,
  count(*)::int AS sample_size,
  round((percentile_cont(0.5) WITHIN GROUP (ORDER BY value))::numeric, 4) AS median,
  round((percentile_cont(0.25) WITHIN GROUP (ORDER BY value))::numeric, 4) AS p25,
  round((percentile_cont(0.75) WITHIN GROUP (ORDER BY value))::numeric, 4) AS p75
FROM sample;
