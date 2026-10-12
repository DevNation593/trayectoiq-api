import { createHmac, randomBytes, randomInt } from 'node:crypto';

/**
 * Huella con clave (HMAC-SHA256, hex) de un secreto de alta entropia: refresh tokens, tokens de un
 * solo uso y codigos. En la base solo se guarda la huella; sin la clave no se puede comprobar un
 * candidato aunque se filtre la tabla. No sirve para contrasenas: esas usan Argon2id.
 */
export const hmacHex = (key: string, value: string): string =>
  createHmac('sha256', key).update(value).digest('hex');

/** Token opaco aleatorio, seguro para URL. 32 bytes = 256 bits. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Codigo numerico de `length` digitos, uniforme. */
export const randomDigits = (length: number): string =>
  Array.from({ length }, () => randomInt(10)).join('');
