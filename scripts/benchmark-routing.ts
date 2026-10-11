// Benchmark de rutas y direcciones (05_ROUTING_GEOCODING_BENCHMARK.md): compara lo que estiman
// Valhalla y Photon con viajes reales medidos y decide el gate G2.
//
//   pnpm benchmark:routing --trips <trips.csv> --destinations <destinations.csv>
//                          [--valhalla http://localhost:8002] [--photon http://localhost:2322]
//                          [--out informe.json]
//
// trips.csv:        id,vehicle_type,origin_lat,origin_lng,dest_lat,dest_lng,departure_local,real_duration_min,real_distance_km
//                   vehicle_type: MOTORCYCLE | CAR. departure_local: YYYY-MM-DDTHH:MM (hora de Quito).
//                   real_distance_km puede ir vacio.
// destinations.csv: query,expected_lat,expected_lng
//
// Codigos de salida: 0 APROBADO, 1 NO_APROBADO, 2 MUESTRA_INSUFICIENTE, 64 uso o datos incorrectos.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { PhotonGeocodingProvider } from '../src/modules/places/providers/photon-geocoding.provider.js';
import { RoutingError } from '../src/modules/routing/domain/routing-provider.js';
import { ValhallaRoutingProvider } from '../src/modules/routing/providers/valhalla-routing.provider.js';
import { haversineMeters, QUITO_SERVICE_AREA, ServiceArea } from '../src/shared/geo/geo.js';
import {
  evaluate,
  type GeocodeSample,
  type Metric,
  parseCsv,
  type TripSample,
  type VehicleType,
} from './benchmark/metrics.js';

const HIT_RADIUS_METERS = 150;

function usage(message: string): never {
  process.stderr.write(
    `${message}\nUso: pnpm benchmark:routing --trips <trips.csv> --destinations <destinations.csv>\n`,
  );
  process.exit(64);
}

const { values: args } = parseArgs({
  options: {
    trips: { type: 'string' },
    destinations: { type: 'string' },
    valhalla: { type: 'string', default: process.env.VALHALLA_URL ?? 'http://localhost:8002' },
    photon: { type: 'string', default: process.env.PHOTON_URL ?? 'http://localhost:2322' },
    out: { type: 'string' },
  },
});
if (!args.trips || !args.destinations) {
  usage('Faltan --trips y --destinations.');
}

const readRows = (file: string, columns: string[]): Record<string, string>[] => {
  let rows: Record<string, string>[];
  try {
    rows = parseCsv(readFileSync(file, 'utf8'));
  } catch (error) {
    usage(`No se pudo leer ${file}: ${(error as Error).message}`);
  }
  const missing = columns.filter((column) => rows[0] && !(column in rows[0]));
  if (rows.length === 0 || missing.length > 0) {
    usage(
      `${file}: ${rows.length === 0 ? 'no tiene filas' : `faltan columnas ${missing.join(', ')}`}`,
    );
  }
  return rows;
};

const number = (file: string, row: Record<string, string>, column: string): number => {
  const value = Number(row[column]);
  if (row[column] === '' || !Number.isFinite(value)) {
    usage(`${file}: "${column}" no es un numero en la fila ${JSON.stringify(row)}`);
  }
  return value;
};

const VEHICLES: Record<string, VehicleType> = {
  MOTORCYCLE: 'MOTORCYCLE',
  MOTO: 'MOTORCYCLE',
  CAR: 'CAR',
  CARRO: 'CAR',
};

const area = process.env.SERVICE_AREA_BBOX
  ? ServiceArea.parse(process.env.SERVICE_AREA_BBOX)
  : QUITO_SERVICE_AREA;
const routing = new ValhallaRoutingProvider({ baseUrl: args.valhalla });
const geocoding = new PhotonGeocodingProvider({ baseUrl: args.photon, serviceArea: area });

for (const provider of [routing, geocoding]) {
  const health = await provider.health();
  if (health.status !== 'up') {
    usage(`${health.provider} no responde (${health.detail ?? 'sin detalle'}).`);
  }
  console.log(`${health.provider}: ${health.detail ?? 'up'}`);
}

const tripRows = readRows(args.trips, [
  'id',
  'vehicle_type',
  'origin_lat',
  'origin_lng',
  'dest_lat',
  'dest_lng',
  'departure_local',
  'real_duration_min',
  'real_distance_km',
]);
const trips: TripSample[] = [];
for (const row of tripRows) {
  const vehicleType = VEHICLES[(row.vehicle_type ?? '').toUpperCase()];
  if (!vehicleType) {
    usage(`${args.trips}: vehicle_type desconocido "${row.vehicle_type}" en el viaje ${row.id}`);
  }
  const sample: TripSample = {
    id: row.id ?? '',
    vehicleType,
    departureLocal: row.departure_local ?? '',
    realDurationSeconds: Math.round(number(args.trips, row, 'real_duration_min') * 60),
    realDistanceMeters:
      row.real_distance_km === ''
        ? null
        : Math.round(number(args.trips, row, 'real_distance_km') * 1000),
    estimatedDurationSeconds: null,
    estimatedDistanceMeters: null,
    routed: false,
    latencyMs: null,
  };
  const started = performance.now();
  try {
    const route = await routing.route({
      profile: vehicleType,
      pickup: {
        lat: number(args.trips, row, 'origin_lat'),
        lng: number(args.trips, row, 'origin_lng'),
      },
      destination: {
        lat: number(args.trips, row, 'dest_lat'),
        lng: number(args.trips, row, 'dest_lng'),
      },
    });
    sample.routed = true;
    sample.estimatedDurationSeconds = route.tripDurationSeconds;
    sample.estimatedDistanceMeters = route.tripDistanceMeters;
  } catch (error) {
    if (!(error instanceof RoutingError)) throw error;
    console.warn(`viaje ${sample.id}: ${error.code}`);
  }
  sample.latencyMs = Math.round(performance.now() - started);
  trips.push(sample);
}

const destinationRows = readRows(args.destinations, ['query', 'expected_lat', 'expected_lng']);
const destinations: GeocodeSample[] = [];
for (const row of destinationRows) {
  const expected = {
    lat: number(args.destinations, row, 'expected_lat'),
    lng: number(args.destinations, row, 'expected_lng'),
  };
  const started = performance.now();
  const suggestions = await geocoding.autocomplete(row.query ?? '');
  const latencyMs = Math.round(performance.now() - started);
  let hit = false;
  for (const suggestion of suggestions) {
    const place = await geocoding.resolve(suggestion.id);
    if (haversineMeters(place, expected) <= HIT_RADIUS_METERS) hit = true;
  }
  destinations.push({ query: row.query ?? '', hit, latencyMs });
}

const report = evaluate(trips, destinations);

const format = (metric: Metric): string => {
  if (metric.value === null) return 'sin datos';
  const isRate = metric.id.includes('latency') === false;
  return isRate ? `${(metric.value * 100).toFixed(1)}%` : `${metric.value} ms`;
};
const limit = (metric: Metric): string => {
  const isRate = metric.id.includes('latency') === false;
  const threshold = isRate ? `${(metric.threshold * 100).toFixed(0)}%` : `${metric.threshold} ms`;
  return metric.rule === 'abs<=' ? `±${threshold}` : `${metric.rule} ${threshold}`;
};

console.log('');
console.table(
  report.metrics.map((metric) => ({
    metrica: metric.label,
    valor: format(metric),
    umbral: limit(metric),
    n: metric.sampleSize,
    resultado: metric.pass ? 'cumple' : 'NO cumple',
  })),
);
console.log(
  `Muestra: ${report.sample.weekdayTrips} viajes en dia laborable ` +
    `(${report.sample.motorcycleTrips} moto, ${report.sample.carTrips} carro), ` +
    `${report.sample.destinations} destinos, ${report.weekend.trips} viajes de fin de semana aparte.`,
);
for (const problem of report.sample.problems) console.log(`  - ${problem}`);
console.log(`\nVeredicto G2: ${report.verdict}`);

if (args.out) {
  const detail = { generatedAt: new Date().toISOString(), report, trips, destinations };
  writeFileSync(args.out, `${JSON.stringify(detail, null, 2)}\n`);
  console.log(`Informe: ${args.out}`);
}

process.exit(report.verdict === 'APROBADO' ? 0 : report.verdict === 'NO_APROBADO' ? 1 : 2);
