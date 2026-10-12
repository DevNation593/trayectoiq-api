-- Negotiation Lift (08_ANALYTICS_VALIDATION.md seccion 4)
-- Parametros: $1 = inicio del periodo (inclusive), $2 = fin (exclusive).
-- (precio final - oferta inicial) / oferta inicial, solo cuando el usuario negocio y acepto.
-- Mediana y cuartiles sobre cotizaciones guardadas en el periodo.
WITH sample AS (
  SELECT (d.final_price - q.offered_price) / q.offered_price AS value
  FROM quote_decisions d
  JOIN quotes q ON q.id = d.quote_id
  WHERE q.created_at >= $1::timestamptz AND q.created_at < $2::timestamptz
    AND d.action = 'NEGOTIATED_AND_ACCEPTED'
    AND d.final_price IS NOT NULL
    AND q.offered_price > 0
)
SELECT
  'negotiation_lift' AS metric,
  count(*)::int AS sample_size,
  round((percentile_cont(0.5) WITHIN GROUP (ORDER BY value))::numeric, 4) AS median,
  round((percentile_cont(0.25) WITHIN GROUP (ORDER BY value))::numeric, 4) AS p25,
  round((percentile_cont(0.75) WITHIN GROUP (ORDER BY value))::numeric, 4) AS p75
FROM sample;
