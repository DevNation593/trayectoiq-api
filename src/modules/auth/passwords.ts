import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id (el algoritmo por defecto de la libreria) con los parametros minimos que recomienda
 * OWASP: 19 MiB de memoria, 2 pasadas, 1 hilo. 06_SECURITY_PRIVACY.md seccion 2.
 */
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export const hashPassword = (password: string): Promise<string> => hash(password, ARGON2_OPTIONS);

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // Un hash ilegible no es una contrasena correcta.
    return false;
  }
}

/**
 * Contrasenas de 10 o mas caracteres que encabezan las listas de filtraciones, mas variantes
 * obvias del producto. La longitud minima la impone el contrato; esto cubre las que la cumplen
 * y aun asi son las primeras que prueba un atacante.
 */
const COMMON_PASSWORDS = new Set([
  '0123456789',
  '0987654321',
  '1111111111',
  '1234567890',
  '12345678910',
  '123456789a',
  '1234567890a',
  '123123123123',
  '1q2w3e4r5t',
  '1q2w3e4r5t6y',
  'aaaaaaaaaa',
  'abcdefghij',
  'abcd123456',
  'administrador',
  'administrator',
  'contrasena123',
  'contraseña123',
  'ecuador2026',
  'iloveyou123',
  'password12',
  'password123',
  'password1234',
  'password12345',
  'password2026',
  'passwordpassword',
  'qwerty12345',
  'qwerty123456',
  'qwertyuiop',
  'qwertyuiop123',
  'quito12345',
  'trayectoiq',
  'trayectoiq123',
  'trayectoiq2026',
  'welcome123',
  'zxcvbnm123',
]);

export const isCommonPassword = (password: string): boolean =>
  COMMON_PASSWORDS.has(password.toLowerCase());
