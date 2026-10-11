# Benchmark de rutas y direcciones

Herramienta del gate G2. Criterios y método: `05_ROUTING_GEOCODING_BENCHMARK.md` en `trayectoiq-docs`.

```bash
docker compose --profile geo up -d
pnpm -s benchmark:routing --trips benchmark/sample/trips.csv --destinations benchmark/sample/destinations.csv
```

## `sample/` no son mediciones

`sample/trips.csv` y `sample/destinations.csv` son **datos de ejemplo** para comprobar que la
herramienta funciona de punta a punta: coordenadas aproximadas de lugares públicos de Quito con
duraciones y distancias inventadas. Su resultado no dice nada sobre la calidad del routing, y con
10 viajes el veredicto siempre es `MUESTRA_INSUFICIENTE`.

## Datos reales

El gate se decide con al menos 100 viajes reales medidos y 100 destinos tal como los escriben los
conductores (salen del concierge MVP y de las entrevistas):

- `benchmark/trips.csv`
- `benchmark/destinations.csv`

Formato de columnas: cabecera de `scripts/benchmark-routing.ts`.

Las coordenadas de viajes reales son datos sensibles. Antes de versionarlas:

- redondear a 4 decimales (~11 m);
- no incluir ningún dato del conductor (nombre, teléfono, placa);
- este repositorio debe seguir siendo privado.
