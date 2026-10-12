import { createHash } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OIDC_KEY_SETS } from '../../src/modules/auth/oidc-verifier.js';
import { call, registerUser } from '../support/api.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

/**
 * Los tokens se firman aqui con una clave de prueba y la API los verifica con su logica real
 * (firma, emisor, audiencia, vencimiento y nonce). Solo se sustituye de donde salen las claves
 * publicas: en produccion, de los JWKS de Google y Apple.
 */

const GOOGLE_CLIENT = 'android-test.apps.googleusercontent.com';
const APPLE_AUDIENCE = 'com.trayectoiq.app.test';

interface AuthBody {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; emailVerified: boolean; displayName: string | null };
}

describe('inicio de sesion con Google y Apple', () => {
  let test: TestApp;
  let db: pg.Pool;
  let signingKey: CryptoKey;
  let otherKey: CryptoKey;
  let subjectCounter = 0;

  interface TokenOptions {
    issuer?: string;
    audience?: string;
    subject?: string;
    email?: string | null;
    emailVerified?: boolean | string;
    nonce?: string;
    expiresInSeconds?: number;
    key?: CryptoKey;
  }

  const mint = (provider: 'google' | 'apple', options: TokenOptions = {}): Promise<string> => {
    const now = Math.floor(test.clock.now().getTime() / 1000);
    const claims: Record<string, unknown> = {
      nonce: options.nonce ?? 'nonce-de-prueba',
      email_verified: options.emailVerified ?? true,
    };
    if (options.email !== null) {
      claims.email = options.email ?? `oauth${(subjectCounter += 1)}@example.com`;
    }
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(
        options.issuer ??
          (provider === 'google' ? 'https://accounts.google.com' : 'https://appleid.apple.com'),
      )
      .setAudience(options.audience ?? (provider === 'google' ? GOOGLE_CLIENT : APPLE_AUDIENCE))
      .setSubject(options.subject ?? `sub-${(subjectCounter += 1)}`)
      .setIssuedAt(now)
      .setExpirationTime(now + (options.expiresInSeconds ?? 300))
      .sign(options.key ?? signingKey);
  };

  const google = (idToken: string, nonce = 'nonce-de-prueba') =>
    call<AuthBody>(test, 'loginGoogle', { body: { idToken, nonce } });

  const apple = (identityToken: string, extra: Record<string, unknown> = {}) =>
    call<AuthBody>(test, 'loginApple', {
      body: { identityToken, authorizationCode: 'codigo', nonce: 'nonce-de-prueba', ...extra },
    });

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    signingKey = pair.privateKey;
    otherKey = (await generateKeyPair('RS256')).privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256' };
    const keys = createLocalJWKSet({ keys: [jwk] });

    process.env.GOOGLE_OAUTH_CLIENT_IDS = `${GOOGLE_CLIENT},ios-test.apps.googleusercontent.com`;
    process.env.APPLE_SIGNIN_AUDIENCE = APPLE_AUDIENCE;
    test = await createTestApp({ overrides: [[OIDC_KEY_SETS, { GOOGLE: keys, APPLE: keys }]] });
    db = new pg.Pool({ connectionString: test.database.url, max: 2 });
  });
  afterAll(async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_IDS;
    delete process.env.APPLE_SIGNIN_AUDIENCE;
    await db?.end();
    await test?.close();
  });

  describe('Google', () => {
    it('crea la cuenta en el primer inicio, con el correo ya verificado y sin contrasena', async () => {
      const { status, body } = await google(await mint('google', { email: 'Nueva@Example.com' }));

      expect(status).toBe(200);
      expect(body.user).toMatchObject({ email: 'nueva@example.com', emailVerified: true });
      const { rows } = await db.query<{ password_hash: string | null }>(
        'SELECT password_hash FROM users WHERE id = $1',
        [body.user.id],
      );
      expect(rows[0]!.password_hash).toBeNull();
      expect((await call(test, 'getMe', { token: body.accessToken })).status).toBe(200);
    });

    it('el mismo sujeto vuelve a la misma cuenta, aunque el correo del proveedor cambie', async () => {
      const first = await google(
        await mint('google', { subject: 'g-fijo', email: 'antes@example.com' }),
      );
      const second = await google(
        await mint('google', { subject: 'g-fijo', email: 'despues@example.com' }),
      );

      expect(second.status).toBe(200);
      expect(second.body.user.id).toBe(first.body.user.id);
      expect(second.body.user.email).toBe('antes@example.com');
    });

    it('acepta cualquiera de los clientes configurados como audiencia', async () => {
      const token = await mint('google', { audience: 'ios-test.apps.googleusercontent.com' });
      expect((await google(token)).status).toBe(200);
    });

    it.each([
      ['otra audiencia', { audience: 'otra-app.apps.googleusercontent.com' }],
      ['otro emisor', { issuer: 'https://accounts.evil.example' }],
      ['vencido', { expiresInSeconds: -60 }],
    ])('rechaza un token de %s', async (_name, options) => {
      const { status, body } = await google(await mint('google', options));
      expect(status).toBe(401);
      expect(body).toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    });

    it('rechaza un token firmado con otra clave', async () => {
      expect((await google(await mint('google', { key: otherKey }))).status).toBe(401);
    });

    it('rechaza un token sin firma (alg none)', async () => {
      const encode = (value: object): string =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
      const now = Math.floor(test.clock.now().getTime() / 1000);
      const unsigned = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
        iss: 'https://accounts.google.com',
        aud: GOOGLE_CLIENT,
        sub: 'sin-firma',
        email: 'sinfirma@example.com',
        email_verified: true,
        nonce: 'nonce-de-prueba',
        iat: now,
        exp: now + 300,
      })}.`;
      expect((await google(unsigned)).status).toBe(401);
    });

    it('rechaza un nonce que no coincide con el del token', async () => {
      const token = await mint('google', { nonce: 'nonce-original' });
      expect((await google(token, 'otro-nonce')).status).toBe(401);
    });

    it('no crea una cuenta si el proveedor no confirmo el correo', async () => {
      const { status } = await google(
        await mint('google', { email: 'sinverificar@example.com', emailVerified: false }),
      );
      expect(status).toBe(401);
      const { rowCount } = await db.query('SELECT 1 FROM users WHERE email = $1', [
        'sinverificar@example.com',
      ]);
      expect(rowCount).toBe(0);
    });

    it('un texto que no es un JWT es 401, no un error interno', async () => {
      expect((await google('esto-no-es-un-token')).status).toBe(401);
    });

    it('una cuenta suspendida no entra', async () => {
      const first = await google(await mint('google', { subject: 'g-suspendido' }));
      await db.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [first.body.user.id]);

      const again = await google(await mint('google', { subject: 'g-suspendido' }));
      expect(again.status).toBe(403);
      expect(again.body).toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
    });
  });

  describe('vinculacion con una cuenta existente (06_SECURITY_PRIVACY.md seccion 2)', () => {
    it('con el correo ya verificado, Google entra a la misma cuenta y la contrasena sigue sirviendo', async () => {
      const session = await registerUser(test);

      const linked = await google(await mint('google', { email: session.email }));

      expect(linked.status).toBe(200);
      expect(linked.body.user.id).toBe(session.userId);
      const password = await call(test, 'login', {
        body: { email: session.email, password: session.password },
      });
      expect(password.status).toBe(200);
    });

    it('con el correo SIN verificar, quien lo registro pierde el acceso: contrasena y sesiones', async () => {
      // Alguien registra el correo de otra persona y nunca lo verifica.
      const squatter = await registerUser(test, {
        email: 'victima@example.com',
        password: 'clave-del-intruso-1',
        verified: false,
      });

      // La duena real del correo entra con Google.
      const owner = await google(await mint('google', { email: 'victima@example.com' }));

      expect(owner.status).toBe(200);
      expect(owner.body.user).toMatchObject({ id: squatter.userId, emailVerified: true });
      expect((await call(test, 'getMe', { token: squatter.accessToken })).status).toBe(401);
      const refresh = await call(test, 'refreshSession', {
        body: { refreshToken: squatter.refreshToken },
      });
      expect(refresh.status).toBe(401);
      const password = await call(test, 'login', {
        body: { email: 'victima@example.com', password: 'clave-del-intruso-1' },
      });
      expect(password.status).toBe(401);
      // El codigo de verificacion que recibio el intruso tampoco sirve ya.
      expect((await call(test, 'getMe', { token: owner.body.accessToken })).status).toBe(200);
    });
  });

  describe('Apple', () => {
    it('crea la cuenta con el nombre que envia la app en el primer inicio', async () => {
      const { status, body } = await apple(
        await mint('apple', { email: 'ana.apple@example.com' }),
        {
          givenName: 'Ana',
          familyName: 'Pérez',
        },
      );

      expect(status).toBe(200);
      expect(body.user).toMatchObject({
        email: 'ana.apple@example.com',
        emailVerified: true,
        displayName: 'Ana Pérez',
      });
    });

    it('acepta el nonce con hash SHA-256, como lo emite Sign in with Apple nativo', async () => {
      const hashed = createHash('sha256').update('nonce-de-prueba').digest('hex');
      const { status } = await apple(await mint('apple', { nonce: hashed }));
      expect(status).toBe(200);
    });

    it('acepta email_verified como texto "true"', async () => {
      const { status } = await apple(await mint('apple', { emailVerified: 'true' }));
      expect(status).toBe(200);
    });

    it('en inicios posteriores entra por el sujeto aunque el token ya no traiga correo', async () => {
      const first = await apple(
        await mint('apple', { subject: 'a-fijo', email: 'fijo@example.com' }),
      );
      const later = await apple(await mint('apple', { subject: 'a-fijo', email: null }));

      expect(later.status).toBe(200);
      expect(later.body.user.id).toBe(first.body.user.id);
    });

    it('sin correo y sin cuenta previa no puede crear nada', async () => {
      const { status } = await apple(await mint('apple', { subject: 'a-nuevo', email: null }));
      expect(status).toBe(401);
    });

    it('un token de Google no sirve en el endpoint de Apple', async () => {
      expect((await apple(await mint('google'))).status).toBe(401);
    });

    it('el mismo sujeto en Google y en Apple son identidades distintas', async () => {
      const viaGoogle = await google(
        await mint('google', { subject: 'compartido', email: 'g@example.com' }),
      );
      const viaApple = await apple(
        await mint('apple', { subject: 'compartido', email: 'a@example.com' }),
      );
      expect(viaApple.body.user.id).not.toBe(viaGoogle.body.user.id);
    });
  });

  it('el limite de intentos por IP tambien aplica al inicio con proveedor', async () => {
    const ip = '10.250.0.1';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await call(test, 'loginGoogle', { ip, body: { idToken: 'malo', nonce: 'n' } });
    }
    const blocked = await call(test, 'loginGoogle', {
      ip,
      body: { idToken: await mint('google'), nonce: 'nonce-de-prueba' },
    });
    expect(blocked.status).toBe(429);
  });
});

describe('inicio con proveedor sin configurar', () => {
  let test: TestApp;
  let signingKey: CryptoKey;

  beforeAll(async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_IDS;
    delete process.env.APPLE_SIGNIN_AUDIENCE;
    const pair = await generateKeyPair('RS256');
    signingKey = pair.privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256' };
    const keys = createLocalJWKSet({ keys: [jwk] });
    test = await createTestApp({ overrides: [[OIDC_KEY_SETS, { GOOGLE: keys, APPLE: keys }]] });
  });
  afterAll(() => test?.close());

  it('sin clientes de Google configurados, ni un token bien firmado entra', async () => {
    const now = Math.floor(test.clock.now().getTime() / 1000);
    const idToken = await new SignJWT({
      email: 'cualquiera@example.com',
      email_verified: true,
      nonce: 'n',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://accounts.google.com')
      .setAudience('cualquier-cliente.apps.googleusercontent.com')
      .setSubject('sin-configurar')
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(signingKey);

    const { status, body } = await call(test, 'loginGoogle', { body: { idToken, nonce: 'n' } });

    expect(status).toBe(401);
    expect(body).toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
  });
});
