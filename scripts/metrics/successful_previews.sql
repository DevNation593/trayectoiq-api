-- Cost per Quote: denominador (08_ANALYTICS_VALIDATION.md seccion 4)
-- Parametros: $1 = inicio del periodo (inclusive), $2 = fin (exclusive).
-- Costo por cotizacion = (routing + geocoding + infraestructura variable) / previews correctos.
-- El numerador sale de la facturacion del proveedor; esta consulta da el denominador y cuantos de
-- esos previews pidieron una ruta nueva, que son los que cuestan (07_UNIT_ECONOMICS.md).
SELECT
  'successful_previews' AS metric,
  count(*)::int AS successful_previews,
  count(*) FILTER (WHERE properties->>'route_reused' = 'false')::int AS route_calculations,
  count(*) FILTER (WHERE properties->>'route_reused' = 'true')::int AS route_reuses
FROM analytics_events
WHERE event_name = 'quote_preview_succeeded'
  AND occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz;
