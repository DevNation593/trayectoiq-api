/** Lo que se registra de cada peticion: nunca la cadena de consulta, que puede llevar coordenadas. */
export function serializeRequest(request: { method?: string; url?: string; id?: unknown }): {
  method?: string;
  path?: string;
  traceId?: unknown;
} {
  return { method: request.method, path: request.url?.split('?')[0], traceId: request.id };
}

/** Claves que nunca deben aparecer en un log, vengan de donde vengan (06_SECURITY_PRIVACY.md seccion 8). */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.newPassword',
  '*.refreshToken',
  '*.accessToken',
  '*.idToken',
  '*.identityToken',
  '*.authorizationCode',
  '*.code',
  '*.token',
  '*.lat',
  '*.lng',
  '*.email',
];

/** Opciones del logger estructurado (pino, a traves de Fastify). */
export function loggerOptions(): {
  level: string;
  redact: { paths: string[]; censor: string };
  serializers: { req: typeof serializeRequest };
} {
  return {
    level: 'info',
    redact: { paths: REDACTED_PATHS, censor: '[redactado]' },
    serializers: { req: serializeRequest },
  };
}
