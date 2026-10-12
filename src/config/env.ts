export type NodeEnv = 'development' | 'test' | 'production';

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
}

const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];
const MIN_SECRET_LENGTH = 32;
/** Mailpit de docker-compose.yml; solo valido fuera de produccion. */
const LOCAL_SMTP_URL = 'smtp://localhost:1025';
const LOCAL_EMAIL_FROM = 'TrayectoIQ <no-reply@trayectoiq.local>';

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
  if (jwtAccessSecret !== '' && jwtAccessSecret === jwtRefreshPepper) {
    problems.push('JWT_ACCESS_SECRET y JWT_REFRESH_PEPPER deben ser distintos');
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

  if (problems.length > 0 || !databaseUrl || !smtpUrl || !emailFrom) {
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
  };
}
