// Metricas del benchmark de rutas y direcciones (05_ROUTING_GEOCODING_BENCHMARK.md seccion 4).
// Funciones puras: el script benchmark-routing.ts consulta a los proveedores y delega aqui.

export type Band = 'PEAK_AM' | 'OFF_PEAK' | 'PEAK_PM';
export type VehicleType = 'MOTORCYCLE' | 'CAR';

export interface TripSample {
  id: string;
  vehicleType: VehicleType;
  /** Hora local de salida, "YYYY-MM-DDTHH:MM" (America/Guayaquil; sin conversion de zona). */
  departureLocal: string;
  realDurationSeconds: number;
  realDistanceMeters: number | null;
  estimatedDurationSeconds: number | null;
  estimatedDistanceMeters: number | null;
  /** false si el proveedor no encontro ruta o no respondio. */
  routed: boolean;
  latencyMs: number | null;
}

export interface GeocodeSample {
  query: string;
  /** El lugar correcto aparecio entre las 5 primeras sugerencias, a menos de 150 m. */
  hit: boolean;
  latencyMs: number | null;
}

export interface Metric {
  id: string;
  label: string;
  value: number | null;
  threshold: number;
  rule: '<=' | '<' | '>=' | 'abs<=';
  pass: boolean;
  sampleSize: number;
}

export interface BenchmarkReport {
  verdict: 'APROBADO' | 'NO_APROBADO' | 'MUESTRA_INSUFICIENTE';
  metrics: Metric[];
  sample: {
    weekdayTrips: number;
    motorcycleTrips: number;
    carTrips: number;
    tripsByBand: Record<Band, number>;
    destinations: number;
    problems: string[];
  };
  weekend: { trips: number; durationAbsMedian: number | null };
}

/** Umbrales de la seccion 4 del documento. Cambiarlos exige cambiar el documento. */
const THRESHOLDS = {
  durationAbsMedian: 0.15,
  durationAbsP90: 0.3,
  durationBias: 0.1,
  distanceAbsMedian: 0.05,
  distanceAbsP90: 0.12,
  geocodingHitRate: 0.8,
  routeLatencyP95Ms: 800,
  autocompleteLatencyP95Ms: 300,
  noRouteRate: 0.01,
};

/** Composicion minima de la muestra (seccion 2 y 3). */
const MINIMUMS = { weekdayTrips: 100, perVehicle: 30, perBand: 25, destinations: 100 };

const BAND_LABELS: Record<Band, string> = {
  PEAK_AM: 'pico manana',
  OFF_PEAK: 'valle',
  PEAK_PM: 'pico tarde',
};

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Percentil por rango mas cercano: el menor valor con al menos p% de la muestra por debajo o igual. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

export function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Pico manana 06:30-09:00, pico tarde 17:00-19:30, el resto valle. */
export function bandOf(departureLocal: string): Band {
  const match = /[T ](\d{2}):(\d{2})/.exec(departureLocal);
  if (!match) {
    throw new Error(`Hora de salida ilegible: "${departureLocal}" (se espera YYYY-MM-DDTHH:MM)`);
  }
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes >= 390 && minutes < 540) return 'PEAK_AM';
  if (minutes >= 1020 && minutes < 1170) return 'PEAK_PM';
  return 'OFF_PEAK';
}

export function isWeekend(departureLocal: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(departureLocal);
  if (!match) {
    throw new Error(`Fecha de salida ilegible: "${departureLocal}" (se espera YYYY-MM-DDTHH:MM)`);
  }
  // La fecha ya es local: se interpreta en UTC solo para obtener el dia de la semana sin desfase.
  const day = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  ).getUTCDay();
  return day === 0 || day === 6;
}

/** CSV con cabecera. Admite campos entre comillas con comas y comillas dobles escapadas. */
export function parseCsv(text: string): Record<string, string>[] {
  const splitLine = (line: string): string[] => {
    const fields: string[] = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (quoted) {
        if (char === '"' && line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else if (char === '"') {
          quoted = false;
        } else {
          current += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === ',') {
        fields.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    fields.push(current);
    return fields.map((field) => field.trim());
  };

  const lines = text.split(/\r?\n/);
  const header = splitLine(lines[0] ?? '');
  const rows: Record<string, string>[] = [];
  lines.slice(1).forEach((line, offset) => {
    if (line.trim() === '') return;
    const fields = splitLine(line);
    if (fields.length !== header.length) {
      throw new Error(
        `CSV: la linea ${offset + 2} tiene ${fields.length} columnas y la cabecera ${header.length}`,
      );
    }
    rows.push(Object.fromEntries(header.map((name, index) => [name, fields[index] ?? ''])));
  });
  return rows;
}

function metric(
  id: string,
  label: string,
  value: number | null,
  threshold: number,
  rule: Metric['rule'],
  sampleSize: number,
): Metric {
  let pass = false;
  if (value !== null) {
    if (rule === '<=') pass = value <= threshold;
    else if (rule === '<') pass = value < threshold;
    else if (rule === '>=') pass = value >= threshold;
    else pass = Math.abs(value) <= threshold;
  }
  // Sin datos no hay evidencia: la metrica no pasa.
  return { id, label, value, threshold, rule, pass, sampleSize };
}

export function evaluate(trips: TripSample[], geocode: GeocodeSample[]): BenchmarkReport {
  const weekday = trips.filter((trip) => !isWeekend(trip.departureLocal));
  const weekend = trips.filter((trip) => isWeekend(trip.departureLocal));

  const durationError = (trip: TripSample): number | null =>
    trip.routed && trip.estimatedDurationSeconds !== null && trip.realDurationSeconds > 0
      ? (trip.estimatedDurationSeconds - trip.realDurationSeconds) / trip.realDurationSeconds
      : null;
  const distanceError = (trip: TripSample): number | null =>
    trip.routed &&
    trip.estimatedDistanceMeters !== null &&
    trip.realDistanceMeters !== null &&
    trip.realDistanceMeters > 0
      ? (trip.estimatedDistanceMeters - trip.realDistanceMeters) / trip.realDistanceMeters
      : null;
  const present = (values: (number | null)[]): number[] =>
    values.filter((value): value is number => value !== null);

  const durationErrors = present(weekday.map(durationError));
  const distanceErrors = present(weekday.map(distanceError));
  const absolute = (values: number[]): number[] => values.map(Math.abs);

  const bands: Band[] = ['PEAK_AM', 'OFF_PEAK', 'PEAK_PM'];
  const tripsByBand = Object.fromEntries(
    bands.map((band) => [
      band,
      weekday.filter((trip) => bandOf(trip.departureLocal) === band).length,
    ]),
  ) as Record<Band, number>;

  const biasMetrics = bands.map((band) => {
    const errors = present(
      weekday.filter((trip) => bandOf(trip.departureLocal) === band).map(durationError),
    );
    return metric(
      `duration_bias_${band}`,
      `Duracion, sesgo medio en ${BAND_LABELS[band]}`,
      mean(errors),
      THRESHOLDS.durationBias,
      'abs<=',
      errors.length,
    );
  });

  const routeLatencies = present(trips.map((trip) => trip.latencyMs));
  const geocodeLatencies = present(geocode.map((sample) => sample.latencyMs));
  const unrouted = weekday.filter((trip) => !trip.routed).length;

  const metrics: Metric[] = [
    metric(
      'duration_abs_median',
      'Duracion, error absoluto mediano',
      median(absolute(durationErrors)),
      THRESHOLDS.durationAbsMedian,
      '<=',
      durationErrors.length,
    ),
    metric(
      'duration_abs_p90',
      'Duracion, error absoluto P90',
      percentile(absolute(durationErrors), 90),
      THRESHOLDS.durationAbsP90,
      '<=',
      durationErrors.length,
    ),
    ...biasMetrics,
    metric(
      'distance_abs_median',
      'Distancia, error absoluto mediano',
      median(absolute(distanceErrors)),
      THRESHOLDS.distanceAbsMedian,
      '<=',
      distanceErrors.length,
    ),
    metric(
      'distance_abs_p90',
      'Distancia, error absoluto P90',
      percentile(absolute(distanceErrors), 90),
      THRESHOLDS.distanceAbsP90,
      '<=',
      distanceErrors.length,
    ),
    metric(
      'geocoding_hit_rate',
      'Direcciones: correcto entre los 5 primeros a menos de 150 m',
      geocode.length === 0 ? null : geocode.filter((sample) => sample.hit).length / geocode.length,
      THRESHOLDS.geocodingHitRate,
      '>=',
      geocode.length,
    ),
    metric(
      'route_latency_p95',
      'Latencia de ruta p95 (ms)',
      percentile(routeLatencies, 95),
      THRESHOLDS.routeLatencyP95Ms,
      '<',
      routeLatencies.length,
    ),
    metric(
      'autocomplete_latency_p95',
      'Latencia de autocompletado p95 (ms)',
      percentile(geocodeLatencies, 95),
      THRESHOLDS.autocompleteLatencyP95Ms,
      '<',
      geocodeLatencies.length,
    ),
    metric(
      'no_route_rate',
      'Rutas sin resultado dentro del area de servicio',
      weekday.length === 0 ? null : unrouted / weekday.length,
      THRESHOLDS.noRouteRate,
      '<',
      weekday.length,
    ),
  ];

  const motorcycleTrips = weekday.filter((trip) => trip.vehicleType === 'MOTORCYCLE').length;
  const carTrips = weekday.filter((trip) => trip.vehicleType === 'CAR').length;
  const problems: string[] = [];
  if (weekday.length < MINIMUMS.weekdayTrips) {
    problems.push(
      `Se necesitan al menos ${MINIMUMS.weekdayTrips} viajes en dia laborable; hay ${weekday.length}.`,
    );
  }
  if (motorcycleTrips < MINIMUMS.perVehicle) {
    problems.push(
      `Se necesitan al menos ${MINIMUMS.perVehicle} viajes en moto; hay ${motorcycleTrips}.`,
    );
  }
  if (carTrips < MINIMUMS.perVehicle) {
    problems.push(`Se necesitan al menos ${MINIMUMS.perVehicle} viajes en carro; hay ${carTrips}.`);
  }
  for (const band of bands) {
    if (tripsByBand[band] < MINIMUMS.perBand) {
      problems.push(
        `Se necesitan al menos ${MINIMUMS.perBand} viajes en ${BAND_LABELS[band]}; hay ${tripsByBand[band]}.`,
      );
    }
  }
  if (geocode.length < MINIMUMS.destinations) {
    problems.push(
      `Se necesitan al menos ${MINIMUMS.destinations} destinos; hay ${geocode.length}.`,
    );
  }

  const verdict =
    problems.length > 0
      ? 'MUESTRA_INSUFICIENTE'
      : metrics.every((candidate) => candidate.pass)
        ? 'APROBADO'
        : 'NO_APROBADO';

  return {
    verdict,
    metrics,
    sample: {
      weekdayTrips: weekday.length,
      motorcycleTrips,
      carTrips,
      tripsByBand,
      destinations: geocode.length,
      problems,
    },
    weekend: {
      trips: weekend.length,
      durationAbsMedian: median(absolute(present(weekend.map(durationError)))),
    },
  };
}
