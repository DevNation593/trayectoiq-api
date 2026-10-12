import { describe, expect, it } from 'vitest';
import { sanitizeClientEvent } from '../../src/modules/analytics/event-catalog.js';
import {
  finalPriceBand,
  initialOfferRelation,
} from '../../src/modules/decisions/decision-analytics.js';
import { waitingMinutesBucket } from '../../src/modules/quotes/quote-analytics.js';

const now = new Date('2026-10-12T15:00:00.000Z');

describe('sanitizeClientEvent', () => {
  it('conserva un evento permitido con sus propiedades permitidas', () => {
    expect(
      sanitizeClientEvent(
        {
          name: 'onboarding_started',
          version: 2,
          occurredAt: '2026-10-12T14:59:00.000Z',
          properties: {
            acquisition_source: 'referido',
            app_platform: 'ANDROID',
            app_version: '1.2.0',
          },
        },
        now,
      ),
    ).toEqual({
      name: 'onboarding_started',
      version: 2,
      occurredAt: new Date('2026-10-12T14:59:00.000Z'),
      properties: { acquisition_source: 'referido', app_platform: 'ANDROID', app_version: '1.2.0' },
    });
  });

  it('sin version ni propiedades usa la version 1 y un objeto vacio', () => {
    expect(
      sanitizeClientEvent({ name: 'app_opened', occurredAt: '2026-10-12T14:00:00Z' }, now),
    ).toEqual({
      name: 'app_opened',
      version: 1,
      occurredAt: new Date('2026-10-12T14:00:00.000Z'),
      properties: {},
    });
  });

  it.each(['quote_saved', 'subscription_activated', 'cualquier_cosa', 'toString', '__proto__'])(
    'descarta el evento %s: solo el servidor puede emitirlo o no existe',
    (name) => {
      expect(sanitizeClientEvent({ name, occurredAt: now.toISOString() }, now)).toBeNull();
    },
  );

  it('descarta las propiedades que el evento no admite y conserva las demas', () => {
    const event = sanitizeClientEvent(
      {
        name: 'paywall_viewed',
        occurredAt: now.toISOString(),
        properties: {
          trigger: 'TRIAL_EXHAUSTED',
          experiment_variant: 'B',
          lat: -0.2201,
          email: 'ana@example.com',
          app_version: '1.0.0',
        },
      },
      now,
    );
    expect(event?.properties).toEqual({ trigger: 'TRIAL_EXHAUSTED', experiment_variant: 'B' });
  });

  it('descarta un texto de mas de 64 caracteres: una propiedad no es un campo de texto libre', () => {
    const event = sanitizeClientEvent(
      {
        name: 'app_opened',
        occurredAt: now.toISOString(),
        properties: { app_platform: 'x'.repeat(65), app_version: 'y'.repeat(64) },
      },
      now,
    );
    expect(event?.properties).toEqual({ app_version: 'y'.repeat(64) });
  });

  it('una fecha futura se guarda como la hora de llegada', () => {
    const event = sanitizeClientEvent(
      { name: 'app_opened', occurredAt: '2026-10-12T15:00:00.001Z' },
      now,
    );
    expect(event?.occurredAt).toEqual(now);
  });
});

describe('waitingMinutesBucket', () => {
  it.each([
    [0, '0'],
    [1, '1-5'],
    [300, '1-5'],
    [301, '6-10'],
    [600, '6-10'],
    [601, '11-15'],
    [900, '11-15'],
    [901, '16+'],
    [10800, '16+'],
  ])('%i segundos de espera caen en %s', (seconds, bucket) => {
    expect(waitingMinutesBucket(seconds)).toBe(bucket);
  });
});

describe('finalPriceBand', () => {
  it.each([
    ['0', 'LT_3'],
    ['2.99', 'LT_3'],
    ['3', '3_TO_5'],
    ['4.999999', '3_TO_5'],
    ['5.00', '5_TO_8'],
    ['7.99', '5_TO_8'],
    ['8', '8_TO_12'],
    ['11.99', '8_TO_12'],
    ['12', '12_TO_20'],
    ['19.99', '12_TO_20'],
    ['20', 'GTE_20'],
    ['350.5', 'GTE_20'],
  ])('un precio final de %s cae en %s', (price, band) => {
    expect(finalPriceBand(price)).toBe(band);
  });
});

describe('initialOfferRelation', () => {
  it.each([
    [null, 'NO_OFFER'],
    ['REJECT', 'BELOW_MIN'],
    ['NEGOTIATE', 'BETWEEN_MIN_REC'],
    ['ACCEPT', 'AT_OR_ABOVE_REC'],
  ] as const)('con recomendacion %s la oferta inicial es %s', (recommendation, relation) => {
    expect(initialOfferRelation(recommendation)).toBe(relation);
  });
});
