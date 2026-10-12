import { describe, expect, it } from 'vitest';
import { loggerOptions, serializeRequest } from '../../src/shared/observability/logger.js';

describe('logs de peticiones', () => {
  it('registra metodo, ruta y traceId, nunca la cadena de consulta', () => {
    const logged = serializeRequest({
      method: 'GET',
      url: '/v1/places/autocomplete?q=mi+casa&lat=-0.2201&lng=-78.5123',
      id: 'trace-1',
    });
    expect(logged).toEqual({ method: 'GET', path: '/v1/places/autocomplete', traceId: 'trace-1' });
    expect(JSON.stringify(logged)).not.toContain('-0.2201');
  });

  it('redacta credenciales, tokens, codigos, correos y coordenadas', () => {
    const { redact } = loggerOptions();
    for (const path of [
      'req.headers.authorization',
      '*.password',
      '*.refreshToken',
      '*.code',
      '*.email',
      '*.lat',
      '*.lng',
    ]) {
      expect(redact.paths).toContain(path);
    }
  });
});
