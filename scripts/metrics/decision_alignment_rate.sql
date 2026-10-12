-- Decision Alignment Rate (08_ANALYTICS_VALIDATION.md seccion 4)
-- Parametros: $1 = inicio del periodo (inclusive), $2 = fin (exclusive).
-- Denominador (decisiones reportables): la cotizacion tenia recomendacion y el usuario acepto,
--   negocio o rechazo. No cuentan UNKNOWN ni CANCELLED_BY_OTHER_PARTY.
-- Numerador (alineadas):
--   REJECT    y rechazo;
--   ACCEPT    y acepto (la oferta o negociando) con precio final >= recomendado;
--   NEGOTIATE y negocio con precio final >= minimo.
WITH counts AS (
  SELECT
    count(*) FILTER (
      WHERE (q.recommendation = 'REJECT' AND d.action = 'REJECTED')
         OR (q.recommendation = 'ACCEPT'
             AND d.action IN ('ACCEPTED_ORIGINAL_OFFER', 'NEGOTIATED_AND_ACCEPTED')
             AND d.final_price >= q.recommended_price)
         OR (q.recommendation = 'NEGOTIATE'
             AND d.action = 'NEGOTIATED_AND_ACCEPTED'
             AND d.final_price >= q.minimum_price)
    )::int AS n,
    count(*)::int AS d
  FROM quote_decisions d
  JOIN quotes q ON q.id = d.quote_id
  WHERE q.created_at >= $1::timestamptz AND q.created_at < $2::timestamptz
    AND q.recommendation IS NOT NULL
    AND d.action IN ('ACCEPTED_ORIGINAL_OFFER', 'NEGOTIATED_AND_ACCEPTED', 'REJECTED')
)
SELECT
  'decision_alignment_rate' AS metric,
  n AS numerator,
  d AS denominator,
  round(n::numeric / NULLIF(d, 0), 4) AS rate,
  round((n + 1.920729 - 1.959964 * sqrt(n::numeric * (d - n) / NULLIF(d, 0) + 0.960365)) / (d + 3.841459), 4) AS ci_low,
  round((n + 1.920729 + 1.959964 * sqrt(n::numeric * (d - n) / NULLIF(d, 0) + 0.960365)) / (d + 3.841459), 4) AS ci_high
FROM counts;
