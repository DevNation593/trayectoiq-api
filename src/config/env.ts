import { ServiceArea } from '../shared/geo/geo.js';

export type NodeEnv = 'development' | 'test' | 'production';
export type RoutingProviderName = 'valhalla' | 'fake';

export interface Env {
  nodeEnv: NodeEnv;
  port: number;
  databaseUrl: string;
  /** Firma de los access tokens (HS256). */
  jwtAccessSecret: string;
  /** Clave del HMAC con que se guardan refresh tokens, codigos y tokens de un solo uso. */
  jwtRefreshPepper: string;
  smtpUrl: string;
  emailFrom: string;
  /** Clientes OAuth de Google aceptados como audiencia (Android, iOS). Vacio = login con Google apagado. */
  googleOauthClientIds: string[];
  /** Bundle id aceptado en Sign in with Apple. null = login con Apple apagado. */
  appleSigninAudience: string | null;
  /** Firma de routeToken y previewToken. */
  previewTokenSecret: string;
  /** `fake` es el proveedor determinista para desarrollo y tests; prohibido en produccion. */
  routingProvider: RoutingProviderName;
  valhallaUrl: string | null;
  photonUrl: string | null;
  /** "minLng,minLat,maxLng,maxLat". */
  serviceAreaBbox: string;
}

const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];
const MIN_SECRET_LENGTH = 32;
/** Mailpit de docker-compose.yml; solo valido fuera de produccion. */
const LOCAL_SMTP_URL = 'smtp://localhost:1025';
const LOCAL_EMAIL_FROM = 'TrayectoIQ <no-reply@trayectoiq.local>';
/** Distrito Metropolitano de Quito y valles; valor inicial (04_ARCHITECTURE.md seccion 4). */
const DEFAULT_SERVICE_AREA_BBOX = '-78.65,-0.45,-78.25,0.08';

export class EnvError extends Error {
  constructor(problems: string[]) {
    super(`Configuracion de entorno invalida:\n- ${problems.join('\n- ')}`);
    this.name = 'EnvError';
  }
}

/**
 * Valida el entorno una sola vez al arrancar. Los mensajes nombran la variable
 * y la regla, nunca su valor: varias llevan credenciales.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const problems: string[] = [];
  const read = (name: string): string | undefined => {
    const value = source[name]?.trim();
    return value ? value : undefined;
  };

  const nodeEnv = (read('NODE_ENV') ?? 'development') as NodeEnv;
  if (!NODE_ENVS.includes(nodeEnv)) {
    problems.push(`NODE_ENV debe ser uno de: ${NODE_ENVS.join(', ')}`);
  }

  const rawPort = read('PORT') ?? '3000';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
    problems.push('PORT debe ser un entero entre 1 y 65535');
  }

  const databaseUrl = read('DATABASE_URL');
  if (!databaseUrl) {
    problems.push('DATABASE_URL es obligatoria');
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push('DATABASE_URL debe empezar por postgresql://');
  }

  const secret = (name: string): string => {
    const value = read(name);
    if (!value) {
      problems.push(`${name} es obligatoria`);
    } else if (value.length < MIN_SECRET_LENGTH) {
      problems.push(`${name} debe tener al menos ${MIN_SECRET_LENGTH} caracteres`);
    }
    return value ?? '';
  };
  const jwtAccessSecret = secret('JWT_ACCESS_SECRET');
  const jwtRefreshPepper = secret('JWT_REFRESH_PEPPER');
  const previewTokenSecret = secret('PREVIEW_TOKEN_SECRET');
  const secrets = [jwtAccessSecret, jwtRefreshPepper, previewTokenSecret].filter(
    (value) => value !== '',
  );
  if (new Set(secrets).size !== secrets.length) {
    problems.push(
      'JWT_ACCESS_SECRET, JWT_REFRESH_PEPPER y PREVIEW_TOKEN_SECRET deben ser distintos entre si',
    );
  }

  const isProduction = nodeEnv === 'production';
  const smtpUrl = read('SMTP_URL') ?? (isProduction ? undefined : LOCAL_SMTP_URL);
  if (!smtpUrl) {
    problems.push('SMTP_URL es obligatoria en produccion');
  } else if (!/^smtps?:\/\//.test(smtpUrl)) {
    problems.push('SMTP_URL debe empezar por smtp:// o smtps://');
  }
  const emailFrom = read('EMAIL_FROM') ?? (isProduction ? undefined : LOCAL_EMAIL_FROM);
  if (!emailFrom) {
    problems.push('EMAIL_FROM es obligatoria en produccion');
  }

  const routingProvider = (read('ROUTING_PROVIDER') ?? (isProduction ? undefined : 'fake')) as
    RoutingProviderName | undefined;
  if (routingProvider !== 'valhalla' && routingProvider !== 'fake') {
    problems.push('ROUTING_PROVIDER debe ser valhalla o fake');
  } else if (routingProvider === 'fake' && isProduction) {
    problems.push('ROUTING_PROVIDER no puede ser fake en produccion');
  }
  const serviceUrl = (name: string): string | null => {
    const value = read(name);
    if (routingProvider !== 'valhalla') return value ?? null;
    if (!value) {
      problems.push(`${name} es obligatoria con ROUTING_PROVIDER=valhalla`);
    } else if (!/^https?:\/\//.test(value)) {
      problems.push(`${name} debe empezar por http:// o https://`);
    }
    return value ?? null;
  };
  const valhallaUrl = serviceUrl('VALHALLA_URL');
  const photonUrl = serviceUrl('PHOTON_URL');

  const serviceAreaBbox = read('SERVICE_AREA_BBOX') ?? DEFAULT_SERVICE_AREA_BBOX;
  try {
    ServiceArea.parse(serviceAreaBbox);
  } catch {
    problems.push('SERVICE_AREA_BBOX debe tener la forma minLng,minLat,maxLng,maxLat');
  }

  if (problems.length > 0 || !databaseUrl || !smtpUrl || !emailFrom || !routingProvider) {
    throw new EnvError(problems);
  }
  return {
    nodeEnv,
    port,
    databaseUrl,
    jwtAccessSecret,
    jwtRefreshPepper,
    smtpUrl,
    emailFrom,
    googleOauthClientIds: (read('GOOGLE_OAUTH_CLIENT_IDS') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== ''),
    appleSigninAudience: read('APPLE_SIGNIN_AUDIENCE') ?? null,
    previewTokenSecret,
    routingProvider,
    valhallaUrl,
    photonUrl,
    serviceAreaBbox,
  };
}
