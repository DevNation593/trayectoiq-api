import { describe, expect, it } from 'vitest';
import {
  bandOf,
  evaluate,
  type GeocodeSample,
  isWeekend,
  mean,
  median,
  parseCsv,
  percentile,
  type TripSample,
} from '../../scripts/benchmark/metrics.js';

describe('estadisticos', () => {
  it('mediana de una lista impar y de una par', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('percentil por rango mas cercano', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 90)).toBe(90);
    expect(percentile(values, 95)).toBe(100);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile([7], 90)).toBe(7);
  });

  it('media', () => {
    expect(mean([1, 2, 3, 6])).toBe(3);
  });

  it('una lista vacia no tiene estadisticos', () => {
    expect(median([])).toBeNull();
    expect(percentile([], 90)).toBeNull();
    expect(mean([])).toBeNull();
  });
});

describe('franjas horarias (05_ROUTING_GEOCODING_BENCHMARK.md seccion 3)', () => {
  it.each([
    ['2026-10-05T06:29', 'OFF_PEAK'],
    ['2026-10-05T06:30', 'PEAK_AM'],
    ['2026-10-05T08:59', 'PEAK_AM'],
    ['2026-10-05T09:00', 'OFF_PEAK'],
    ['2026-10-05T12:00', 'OFF_PEAK'],
    ['2026-10-05T17:00', 'PEAK_PM'],
    ['2026-10-05T19:29', 'PEAK_PM'],
    ['2026-10-05T19:30', 'OFF_PEAK'],
    ['2026-10-05 07:15', 'PEAK_AM'],
  ])('%s es %s', (departure, band) => {
    expect(bandOf(departure)).toBe(band);
  });

  it('rechaza una hora ilegible', () => {
    expect(() => bandOf('ayer por la tarde')).toThrow();
  });

  it('distingue fin de semana sin depender de la zona horaria del equipo', () => {
    expect(isWeekend('2026-10-05T08:00')).toBe(false); // lunes
    expect(isWeekend('2026-10-09T23:59')).toBe(false); // viernes
    expect(isWeekend('2026-10-10T00:01')).toBe(true); // sabado
    expect(isWeekend('2026-10-11T12:00')).toBe(true); // domingo
  });
});

describe('parseCsv', () => {
  it('lee cabecera y filas, ignorando lineas vacias y finales de linea de Windows', () => {
    expect(parseCsv('id,name\r\n1,Uno\r\n\r\n2,Dos\r\n')).toEqual([
      { id: '1', name: 'Uno' },
      { id: '2', name: 'Dos' },
    ]);
  });

  it('respeta comas y comillas dentro de un campo entre comillas', () => {
    expect(
      parseCsv('query,lat\n"Av. Amazonas, y Naciones Unidas",-0.17\n"dice ""hola""",1\n'),
    ).toEqual([
      { query: 'Av. Amazonas, y Naciones Unidas', lat: '-0.17' },
      { query: 'dice "hola"', lat: '1' },
    ]);
  });

  it('rechaza una fila con distinta cantidad de columnas, indicando la linea', () => {
    expect(() => parseCsv('a,b\n1,2\n3\n')).toThrow(/linea 3/);
  });
});

const trip = (extra: Partial<TripSample>): TripSample => ({
  id: 't',
  vehicleType: 'MOTORCYCLE',
  departureLocal: '2026-10-05T12:00',
  realDurationSeconds: 1000,
  realDistanceMeters: 5000,
  estimatedDurationSeconds: 1000,
  estimatedDistanceMeters: 5000,
  routed: true,
  latencyMs: 50,
  ...extra,
});

const metric = (report: ReturnType<typeof evaluate>, id: string) => {
  const found = report.metrics.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`No existe la metrica ${id}`);
  return found;
};

describe('evaluate', () => {
  it('calcula el error de duracion como (estimada - real) / real', () => {
    const report = evaluate(
      [
        trip({ id: 'a', estimatedDurationSeconds: 900 }), // -10%
        trip({ id: 'b', estimatedDurationSeconds: 1200 }), // +20%
        trip({ id: 'c', estimatedDurationSeconds: 1000 }), // 0%
      ],
      [],
    );
    expect(metric(report, 'duration_abs_median').value).toBeCloseTo(0.1, 9);
    expect(metric(report, 'duration_abs_p90').value).toBeCloseTo(0.2, 9);
    expect(metric(report, 'duration_bias_OFF_PEAK').value).toBeCloseTo(0.1 / 3, 9);
  });

  it('el sesgo se mide por franja y delata un motor que se queda corto en hora pico', () => {
    const peak = Array.from({ length: 4 }, (_, index) =>
      trip({ id: `p${index}`, departureLocal: '2026-10-05T07:30', estimatedDurationSeconds: 800 }),
    );
    const valley = Array.from({ length: 4 }, (_, index) => trip({ id: `v${index}` }));
    const report = evaluate([...peak, ...valley], []);

    const bias = metric(report, 'duration_bias_PEAK_AM');
    expect(bias.value).toBeCloseTo(-0.2, 9);
    expect(bias.pass).toBe(false);
    expect(metric(report, 'duration_bias_OFF_PEAK').pass).toBe(true);
  });

  it('aplica los umbrales del documento: 15% mediana, 30% P90, ±10% de sesgo', () => {
    const good = evaluate([trip({ estimatedDurationSeconds: 1150 })], []);
    expect(metric(good, 'duration_abs_median')).toMatchObject({ threshold: 0.15, pass: true });

    const bad = evaluate([trip({ estimatedDurationSeconds: 1160 })], []);
    expect(metric(bad, 'duration_abs_median').pass).toBe(false);
    expect(metric(bad, 'duration_bias_OFF_PEAK').pass).toBe(false);
  });

  it('la distancia solo usa los viajes que traen distancia real', () => {
    const report = evaluate(
      [
        trip({ id: 'a', estimatedDistanceMeters: 5200 }), // 4%
        trip({ id: 'b', realDistanceMeters: null, estimatedDistanceMeters: 99999 }),
      ],
      [],
    );
    expect(metric(report, 'distance_abs_median').value).toBeCloseTo(0.04, 9);
    expect(metric(report, 'distance_abs_median').sampleSize).toBe(1);
  });

  it('cuenta las rutas sin resultado y no las usa para el error', () => {
    const report = evaluate(
      [trip({ id: 'a' }), trip({ id: 'b', routed: false, estimatedDurationSeconds: null })],
      [],
    );
    expect(metric(report, 'no_route_rate').value).toBeCloseTo(0.5, 9);
    expect(metric(report, 'no_route_rate').pass).toBe(false);
    expect(metric(report, 'duration_abs_median').sampleSize).toBe(1);
  });

  it('latencia p95 de rutas y de autocompletado', () => {
    const trips = [10, 20, 900].map((latencyMs, index) => trip({ id: `${index}`, latencyMs }));
    const geocode: GeocodeSample[] = [
      { query: 'a', hit: true, latencyMs: 100 },
      { query: 'b', hit: true, latencyMs: 250 },
    ];
    const report = evaluate(trips, geocode);
    expect(metric(report, 'route_latency_p95')).toMatchObject({ value: 900, pass: false });
    expect(metric(report, 'autocomplete_latency_p95')).toMatchObject({ value: 250, pass: true });
  });

  it('tasa de acierto de direcciones contra el 80%', () => {
    const geocode: GeocodeSample[] = [
      { query: 'a', hit: true, latencyMs: 10 },
      { query: 'b', hit: true, latencyMs: 10 },
      { query: 'c', hit: true, latencyMs: 10 },
      { query: 'd', hit: true, latencyMs: 10 },
      { query: 'e', hit: false, latencyMs: 10 },
    ];
    expect(metric(evaluate([trip({})], geocode), 'geocoding_hit_rate')).toMatchObject({
      value: 0.8,
      pass: true,
    });
  });

  it('los fines de semana se informan aparte y no entran en los criterios', () => {
    const report = evaluate(
      [
        trip({ id: 'laborable' }),
        trip({ id: 'sabado', departureLocal: '2026-10-10T12:00', estimatedDurationSeconds: 3000 }),
      ],
      [],
    );
    expect(metric(report, 'duration_abs_median').value).toBe(0);
    expect(report.weekend).toMatchObject({ trips: 1 });
    expect(report.weekend.durationAbsMedian).toBeCloseTo(2, 9);
  });

  it('una metrica sin datos no pasa: no hay evidencia', () => {
    const report = evaluate([trip({ realDistanceMeters: null })], []);
    expect(metric(report, 'distance_abs_median')).toMatchObject({ value: null, pass: false });
    expect(metric(report, 'geocoding_hit_rate')).toMatchObject({ value: null, pass: false });
    expect(metric(report, 'duration_bias_PEAK_AM')).toMatchObject({ value: null, pass: false });
  });

  describe('veredicto', () => {
    const fullSample = (): TripSample[] =>
      Array.from({ length: 120 }, (_, index) =>
        trip({
          id: `t${index}`,
          vehicleType: index % 2 === 0 ? 'MOTORCYCLE' : 'CAR',
          departureLocal: ['2026-10-05T07:30', '2026-10-05T12:00', '2026-10-05T18:00'][index % 3]!,
        }),
      );
    const fullGeocode = (): GeocodeSample[] =>
      Array.from({ length: 100 }, (_, index) => ({ query: `q${index}`, hit: true, latencyMs: 20 }));

    it('MUESTRA_INSUFICIENTE con 10 viajes, aunque todas las metricas pasen', () => {
      const report = evaluate(fullSample().slice(0, 10), fullGeocode());
      expect(report.verdict).toBe('MUESTRA_INSUFICIENTE');
      expect(report.sample.problems.join(' ')).toContain('100');
    });

    it('APROBADO con muestra suficiente y todas las metricas dentro del umbral', () => {
      const report = evaluate(fullSample(), fullGeocode());
      expect(report.sample.problems).toEqual([]);
      expect(report.metrics.filter((candidate) => !candidate.pass)).toEqual([]);
      expect(report.verdict).toBe('APROBADO');
    });

    it('NO_APROBADO con muestra suficiente y alguna metrica fuera', () => {
      const trips = fullSample().map((sample) => ({ ...sample, estimatedDurationSeconds: 700 }));
      expect(evaluate(trips, fullGeocode()).verdict).toBe('NO_APROBADO');
    });

    it('exige al menos 30 viajes en moto y 30 en carro, y 100 destinos', () => {
      const onlyMoto = fullSample().map((sample) => ({
        ...sample,
        vehicleType: 'MOTORCYCLE' as const,
      }));
      const report = evaluate(onlyMoto, fullGeocode().slice(0, 40));
      expect(report.verdict).toBe('MUESTRA_INSUFICIENTE');
      expect(report.sample.problems.join(' ')).toMatch(/carro/);
      expect(report.sample.problems.join(' ')).toMatch(/destinos/);
    });
  });
});
