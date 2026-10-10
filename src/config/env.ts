export type NodeEnv = 'development' | 'test' | 'production';

export interface Env {
  nodeEnv: NodeEnv;
  port: number;
  databaseUrl: string;
}

const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];

export class EnvError extends Error {
  constructor(problems: string[]) {
    super(`Configuracion de entorno invalida:\n- ${problems.join('\n- ')}`);
    this.name = 'EnvError';
  }
}

/**
 * Valida el entorno una sola vez al arrancar. Los mensajes nombran la variable
 * y la regla, nunca su valor: DATABASE_URL lleva credenciales.
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

  if (problems.length > 0 || !databaseUrl) {
    throw new EnvError(problems);
  }
  return { nodeEnv, port, databaseUrl };
}
