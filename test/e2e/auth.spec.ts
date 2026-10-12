import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, lastCode, nextIp, registerUser } from '../support/api.js';
import { createTestApp, type TestApp } from '../support/test-app.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

interface AuthBody {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  user: Record<string, unknown>;
}

describe('autenticacion', () => {
  let test: TestApp;
  let db: pg.Pool;

  beforeAll(async () => {
    test = await createTestApp();
    db = new pg.Pool({ connectionString: test.database.url, max: 2 });
  });
  afterAll(async () => {
    await db?.end();
    await test?.close();
  });

  describe('registro', () => {
    it('crea la cuenta y devuelve sesion y usuario', async () => {
      const { status, body } = await call<AuthBody>(test, 'register', {
        body: {
          email: 'Ana.Perez@Example.com',
          password: 'clave-de-prueba-larga',
          displayName: 'Ana',
        },
      });

      expect(status).toBe(201);
      expect(body.accessToken).toEqual(expect.any(String));
      expect(body.refreshToken).toEqual(expect.any(String));
      expect(body.expiresInSeconds).toBe(900);
      expect(body.user).toMatchObject({
        email: 'ana.perez@example.com',
        emailVerified: false,
        displayName: 'Ana',
        role: 'USER',
        countryCode: 'EC',
        currency: 'USD',
        timezone: 'America/Guayaquil',
      });
    });

    it('guarda la contrasena con Argon2id, nunca en claro', async () => {
      const session = await registerUser(test, { verified: false });
      const { rows } = await db.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = $1',
        [session.userId],
      );
      expect(rows[0]!.password_hash).toMatch(/^\$argon2id\$/);
      expect(rows[0]!.password_hash).not.toContain(session.password);
    });

    it('envia un codigo de verificacion de 6 digitos al correo registrado', async () => {
      const session = await registerUser(test, { verified: false });
      expect(lastCode(test, session.email)).toMatch(/^\d{6}$/);
    });

    it('un correo ya registrado es 409, sin distinguir mayusculas', async () => {
      const session = await registerUser(test, { verified: false });
      const { status, body } = await call(test, 'register', {
        body: { email: session.email.toUpperCase(), password: 'otra-clave-bien-larga' },
      });
      expect(status).toBe(409);
      expect(body).toMatchObject({ code: 'EMAIL_ALREADY_REGISTERED' });
    });

    it('un cuerpo invalido es 422 con el error por campo', async () => {
      const { status, body } = await call(test, 'register', {
        body: { email: 'no-es-correo', password: 'corta' },
      });
      expect(status).toBe(422);
      expect(body).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((body.errors as { field: string }[]).map((error) => error.field).sort()).toEqual([
        'email',
        'password',
      ]);
    });

    it('rechaza una contrasena de las listas mas comunes', async () => {
      const { status, body } = await call(test, 'register', {
        body: { email: 'comun@example.com', password: 'password123' },
      });
      expect(status).toBe(422);
      expect(body.errors).toEqual([
        expect.objectContaining({ field: 'password', code: 'commonPassword' }),
      ]);
    });

    it('no permite elegir el rol al registrarse', async () => {
      const { status } = await call(test, 'register', {
        body: { email: 'admin@example.com', password: 'clave-de-prueba-larga', role: 'ADMIN' },
      });
      expect(status).toBe(422);
    });

    it('el cuarto registro desde la misma IP en una hora es 429 con Retry-After', async () => {
      const ip = nextIp();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const ok = await call(test, 'register', {
          ip,
          body: { email: `ip${attempt}@example.com`, password: 'clave-de-prueba-larga' },
        });
        expect(ok.status).toBe(201);
      }
      const blocked = await call(test, 'register', {
        ip,
        body: { email: 'ip3@example.com', password: 'clave-de-prueba-larga' },
      });
      expect(blocked.status).toBe(429);
      expect(blocked.body).toMatchObject({ code: 'RATE_LIMITED' });
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    });
  });

  describe('inicio de sesion', () => {
    it('devuelve una sesion nueva con credenciales correctas', async () => {
      const session = await registerUser(test);
      const { status, body } = await call<AuthBody>(test, 'login', {
        body: {
          email: session.email.toUpperCase(),
          password: session.password,
          platform: 'ANDROID',
        },
      });
      expect(status).toBe(200);
      expect(body.user).toMatchObject({ id: session.userId, emailVerified: true });
      expect(body.refreshToken).not.toBe(session.refreshToken);
    });

    it('contrasena incorrecta y correo inexistente responden exactamente lo mismo', async () => {
      const session = await registerUser(test);
      const wrong = await call(test, 'login', {
        body: { email: session.email, password: 'no-es-la-clave' },
      });
      const unknown = await call(test, 'login', {
        body: { email: 'nadie@example.com', password: 'no-es-la-clave' },
      });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      const { traceId: _a, ...wrongBody } = wrong.body;
      const { traceId: _b, ...unknownBody } = unknown.body;
      expect(wrongBody).toEqual(unknownBody);
      expect(wrongBody).toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    });

    it('el sexto intento en un minuto desde la misma IP es 429 con Retry-After', async () => {
      const session = await registerUser(test);
      const ip = nextIp();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const failed = await call(test, 'login', {
          ip,
          body: { email: `otro${attempt}@example.com`, password: 'no-es-la-clave' },
        });
        expect(failed.status).toBe(401);
      }
      const blocked = await call(test, 'login', {
        ip,
        body: { email: session.email, password: session.password },
      });
      expect(blocked.status).toBe(429);
      expect(blocked.body).toMatchObject({ code: 'RATE_LIMITED' });
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(60);

      test.clock.advance(MINUTE);
      const allowed = await call(test, 'login', {
        ip,
        body: { email: session.email, password: session.password },
      });
      expect(allowed.status).toBe(200);
    });

    it('el limite tambien cuenta por correo, aunque cambie la IP', async () => {
      const session = await registerUser(test);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await call(test, 'login', { body: { email: session.email, password: 'no-es-la-clave' } });
      }
      const blocked = await call(test, 'login', {
        body: { email: session.email, password: session.password },
      });
      expect(blocked.status).toBe(429);
      test.clock.advance(MINUTE);
    });

    it('una cuenta suspendida no puede entrar', async () => {
      const session = await registerUser(test);
      await db.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [session.userId]);
      const { status, body } = await call(test, 'login', {
        body: { email: session.email, password: session.password },
      });
      expect(status).toBe(403);
      expect(body).toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
    });

    it('una cuenta sin contrasena (solo OAuth) no entra por contrasena', async () => {
      const session = await registerUser(test);
      await db.query('UPDATE users SET password_hash = NULL WHERE id = $1', [session.userId]);
      const { status } = await call(test, 'login', {
        body: { email: session.email, password: session.password },
      });
      expect(status).toBe(401);
    });
  });

  describe('acceso con el access token', () => {
    it('GET /me devuelve el usuario de la sesion', async () => {
      const session = await registerUser(test);
      const { status, body } = await call(test, 'getMe', { token: session.accessToken });
      expect(status).toBe(200);
      expect(body).toMatchObject({ id: session.userId, email: session.email, emailVerified: true });
    });

    it('sin token es 401', async () => {
      const { status, body } = await call(test, 'getMe');
      expect(status).toBe(401);
      expect(body).toMatchObject({ code: 'AUTH_TOKEN_EXPIRED' });
    });

    it('un token alterado es 401', async () => {
      const session = await registerUser(test);
      const tampered = `${session.accessToken.slice(0, -4)}AAAA`;
      expect((await call(test, 'getMe', { token: tampered })).status).toBe(401);
    });

    it('el access token vence a los 15 minutos', async () => {
      const session = await registerUser(test);
      test.clock.advance(14 * MINUTE);
      expect((await call(test, 'getMe', { token: session.accessToken })).status).toBe(200);
      test.clock.advance(2 * MINUTE);
      const expired = await call(test, 'getMe', { token: session.accessToken });
      expect(expired.status).toBe(401);
      expect(expired.body).toMatchObject({ code: 'AUTH_TOKEN_EXPIRED' });
    });

    it('suspender la cuenta corta el acceso de inmediato', async () => {
      const session = await registerUser(test);
      await db.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [session.userId]);
      const { status, body } = await call(test, 'getMe', { token: session.accessToken });
      expect(status).toBe(403);
      expect(body).toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
    });
  });

  describe('refresh rotatorio', () => {
    it('entrega tokens nuevos y el refresh anterior deja de servir', async () => {
      const session = await registerUser(test);
      const refreshed = await call<AuthBody>(test, 'refreshSession', {
        body: { refreshToken: session.refreshToken },
      });
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.refreshToken).not.toBe(session.refreshToken);
      expect((await call(test, 'getMe', { token: refreshed.body.accessToken })).status).toBe(200);

      // El refresh nuevo es el que vale a partir de ahora: sirve para la siguiente rotacion.
      const again = await call<AuthBody>(test, 'refreshSession', {
        body: { refreshToken: refreshed.body.refreshToken },
      });
      expect(again.status).toBe(200);
      expect(again.body.refreshToken).not.toBe(refreshed.body.refreshToken);
    });

    it('reusar un refresh viejo despues de 10 segundos revoca toda la sesion', async () => {
      const session = await registerUser(test);
      const refreshed = await call<AuthBody>(test, 'refreshSession', {
        body: { refreshToken: session.refreshToken },
      });
      test.clock.advance(11_000);

      const reuse = await call(test, 'refreshSession', {
        body: { refreshToken: session.refreshToken },
      });
      expect(reuse.status).toBe(401);
      expect(reuse.body).toMatchObject({ code: 'AUTH_SESSION_REVOKED' });

      // Quien robo el token y quien lo tenia legitimamente quedan fuera por igual.
      const legit = await call(test, 'refreshSession', {
        body: { refreshToken: refreshed.body.refreshToken },
      });
      expect(legit.status).toBe(401);
      const access = await call(test, 'getMe', { token: refreshed.body.accessToken });
      expect(access.status).toBe(401);
      expect(access.body).toMatchObject({ code: 'AUTH_SESSION_REVOKED' });

      const { rows } = await db.query<{ revoked_reason: string }>(
        'SELECT revoked_reason FROM auth_sessions WHERE user_id = $1',
        [session.userId],
      );
      expect(rows.map((row) => row.revoked_reason)).toContain('REUSE_DETECTED');
    });

    it('un reintento dentro de los 10 segundos (respuesta perdida) no revoca la sesion', async () => {
      const session = await registerUser(test);
      await call(test, 'refreshSession', { body: { refreshToken: session.refreshToken } });
      test.clock.advance(5_000);

      const retry = await call<AuthBody>(test, 'refreshSession', {
        body: { refreshToken: session.refreshToken },
      });
      expect(retry.status).toBe(200);
      expect((await call(test, 'getMe', { token: retry.body.accessToken })).status).toBe(200);
    });

    it('un refresh token inventado es 401', async () => {
      const { status, body } = await call(test, 'refreshSession', {
        body: { refreshToken: 'no-existe-este-token' },
      });
      expect(status).toBe(401);
      expect(body).toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    });

    it('la sesion vence a los 60 dias sin uso', async () => {
      const session = await registerUser(test);
      test.clock.advance(61 * DAY);
      const { status, body } = await call(test, 'refreshSession', {
        body: { refreshToken: session.refreshToken },
      });
      expect(status).toBe(401);
      expect(body).toMatchObject({ code: 'AUTH_TOKEN_EXPIRED' });
    });

    it('solo se guarda el hash del refresh token', async () => {
      const session = await registerUser(test);
      const { rows } = await db.query<{ refresh_token_hash: string }>(
        'SELECT refresh_token_hash FROM auth_sessions WHERE user_id = $1',
        [session.userId],
      );
      expect(rows[0]!.refresh_token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]!.refresh_token_hash).not.toBe(session.refreshToken);
    });
  });

  describe('cierre de sesion', () => {
    it('logout revoca la sesion actual: ni el access ni el refresh vuelven a servir', async () => {
      const session = await registerUser(test);
      expect((await call(test, 'logout', { token: session.accessToken })).status).toBe(204);

      const access = await call(test, 'getMe', { token: session.accessToken });
      expect(access.status).toBe(401);
      expect(access.body).toMatchObject({ code: 'AUTH_SESSION_REVOKED' });
      const refresh = await call(test, 'refreshSession', {
        body: { refreshToken: session.refreshToken },
      });
      expect(refresh.status).toBe(401);
    });

    it('logout no afecta a otras sesiones; logout-all las cierra todas', async () => {
      const first = await registerUser(test);
      const second = await call<AuthBody>(test, 'login', {
        body: { email: first.email, password: first.password },
      });

      await call(test, 'logout', { token: first.accessToken });
      expect((await call(test, 'getMe', { token: second.body.accessToken })).status).toBe(200);

      const third = await call<AuthBody>(test, 'login', {
        body: { email: first.email, password: first.password },
      });
      expect((await call(test, 'logoutAll', { token: third.body.accessToken })).status).toBe(204);
      expect((await call(test, 'getMe', { token: second.body.accessToken })).status).toBe(401);
      expect((await call(test, 'getMe', { token: third.body.accessToken })).status).toBe(401);
    });
  });

  describe('verificacion de correo', () => {
    it('el codigo correcto verifica el correo', async () => {
      const session = await registerUser(test, { verified: false });
      const verify = await call(test, 'verifyEmail', {
        token: session.accessToken,
        body: { code: lastCode(test, session.email) },
      });
      expect(verify.status).toBe(204);
      const me = await call(test, 'getMe', { token: session.accessToken });
      expect(me.body).toMatchObject({ emailVerified: true });
    });

    it('un codigo incorrecto es 422 EMAIL_CODE_INVALID', async () => {
      const session = await registerUser(test, { verified: false });
      const code = lastCode(test, session.email);
      const wrong = code === '000000' ? '000001' : '000000';
      const { status, body } = await call(test, 'verifyEmail', {
        token: session.accessToken,
        body: { code: wrong },
      });
      expect(status).toBe(422);
      expect(body).toMatchObject({ code: 'EMAIL_CODE_INVALID' });
    });

    it('tras 5 intentos fallidos el codigo queda invalidado, aunque despues llegue el correcto', async () => {
      const session = await registerUser(test, { verified: false });
      const code = lastCode(test, session.email);
      const wrong = code === '000000' ? '000001' : '000000';
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await call(test, 'verifyEmail', { token: session.accessToken, body: { code: wrong } });
      }
      const late = await call(test, 'verifyEmail', { token: session.accessToken, body: { code } });
      expect(late.status).toBe(422);
      expect(late.body).toMatchObject({ code: 'EMAIL_CODE_INVALID' });
    });

    it('el codigo vence a los 15 minutos', async () => {
      const session = await registerUser(test, { verified: false });
      const code = lastCode(test, session.email);
      test.clock.advance(14 * MINUTE);
      const renewed = await call<AuthBody>(test, 'refreshSession', {
        body: { refreshToken: session.refreshToken },
      });
      test.clock.advance(2 * MINUTE);
      const { status } = await call(test, 'verifyEmail', {
        token: renewed.body.accessToken,
        body: { code },
      });
      expect(status).toBe(422);
    });

    it('reenviar genera un codigo nuevo e invalida el anterior', async () => {
      const session = await registerUser(test, { verified: false });
      const first = lastCode(test, session.email);
      const resend = await call(test, 'resendEmailVerification', { token: session.accessToken });
      expect(resend.status).toBe(202);
      const second = lastCode(test, session.email);

      if (second !== first) {
        const old = await call(test, 'verifyEmail', {
          token: session.accessToken,
          body: { code: first },
        });
        expect(old.status).toBe(422);
      }
      const fresh = await call(test, 'verifyEmail', {
        token: session.accessToken,
        body: { code: second },
      });
      expect(fresh.status).toBe(204);
    });

    it('el cuarto reenvio en una hora es 429', async () => {
      const session = await registerUser(test, { verified: false });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const ok = await call(test, 'resendEmailVerification', { token: session.accessToken });
        expect(ok.status).toBe(202);
      }
      const blocked = await call(test, 'resendEmailVerification', { token: session.accessToken });
      expect(blocked.status).toBe(429);
    });

    it('con el correo ya verificado, reenviar no manda nada', async () => {
      const session = await registerUser(test);
      const before = test.emails.sent.length;
      const resend = await call(test, 'resendEmailVerification', { token: session.accessToken });
      expect(resend.status).toBe(202);
      expect(test.emails.sent.length).toBe(before);
    });

    it('verificar exige sesion', async () => {
      expect((await call(test, 'verifyEmail', { body: { code: '123456' } })).status).toBe(401);
    });
  });

  describe('recuperacion de contrasena', () => {
    const resetToken = (email: string): string => {
      const text = test.emails.lastTo(email)?.text ?? '';
      const token = /token: (\S+)/i.exec(text)?.[1];
      if (!token) throw new Error(`No hay correo de recuperacion para ${email}`);
      return token;
    };

    it('responde igual exista o no el correo, y solo envia si existe', async () => {
      const session = await registerUser(test);
      const before = test.emails.sent.length;

      const existing = await call(test, 'forgotPassword', { body: { email: session.email } });
      const unknown = await call(test, 'forgotPassword', { body: { email: 'nadie@example.com' } });

      expect(existing.status).toBe(202);
      expect(unknown.status).toBe(202);
      expect(existing.body).toEqual(unknown.body);
      expect(test.emails.sent.length).toBe(before + 1);
      expect(test.emails.lastTo('nadie@example.com')).toBeUndefined();
    });

    it('con el token se cambia la contrasena y se cierran todas las sesiones', async () => {
      const session = await registerUser(test);
      await call(test, 'forgotPassword', { body: { email: session.email } });

      const reset = await call(test, 'resetPassword', {
        body: { token: resetToken(session.email), newPassword: 'una-clave-totalmente-nueva' },
      });
      expect(reset.status).toBe(204);

      expect((await call(test, 'getMe', { token: session.accessToken })).status).toBe(401);
      const oldLogin = await call(test, 'login', {
        body: { email: session.email, password: session.password },
      });
      expect(oldLogin.status).toBe(401);
      const newLogin = await call(test, 'login', {
        body: { email: session.email, password: 'una-clave-totalmente-nueva' },
      });
      expect(newLogin.status).toBe(200);
    });

    it('el token sirve una sola vez', async () => {
      const session = await registerUser(test);
      await call(test, 'forgotPassword', { body: { email: session.email } });
      const token = resetToken(session.email);
      await call(test, 'resetPassword', { body: { token, newPassword: 'primera-clave-nueva-1' } });

      const again = await call(test, 'resetPassword', {
        body: { token, newPassword: 'segunda-clave-nueva-2' },
      });
      expect(again.status).toBe(422);
      expect(again.body.errors).toEqual([expect.objectContaining({ field: 'token' })]);
    });

    it('el token vence a los 30 minutos', async () => {
      const session = await registerUser(test);
      await call(test, 'forgotPassword', { body: { email: session.email } });
      const token = resetToken(session.email);
      test.clock.advance(31 * MINUTE);

      const { status } = await call(test, 'resetPassword', {
        body: { token, newPassword: 'una-clave-totalmente-nueva' },
      });
      expect(status).toBe(422);
    });

    it('la contrasena nueva pasa por las mismas reglas', async () => {
      const session = await registerUser(test);
      await call(test, 'forgotPassword', { body: { email: session.email } });
      const { status, body } = await call(test, 'resetPassword', {
        body: { token: resetToken(session.email), newPassword: 'password123' },
      });
      expect(status).toBe(422);
      expect(body.errors).toEqual([
        expect.objectContaining({ field: 'newPassword', code: 'commonPassword' }),
      ]);
    });

    it('solo se guarda el hash del token', async () => {
      const session = await registerUser(test);
      await call(test, 'forgotPassword', { body: { email: session.email } });
      const { rows } = await db.query<{ token_hash: string }>(
        'SELECT token_hash FROM password_reset_tokens WHERE user_id = $1',
        [session.userId],
      );
      expect(rows[0]!.token_hash).not.toBe(resetToken(session.email));
      expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('el cuarto pedido de recuperacion para el mismo correo en una hora es 429', async () => {
      const email = 'insistente@example.com';
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect((await call(test, 'forgotPassword', { body: { email } })).status).toBe(202);
      }
      expect((await call(test, 'forgotPassword', { body: { email } })).status).toBe(429);
    });
  });
});
