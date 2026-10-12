import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import type { User } from '../../generated/prisma/client.js';
import { accountSuspended } from '../../shared/auth/auth.guard.js';
import { hmacHex, randomDigits, randomToken } from '../../shared/auth/secrets.js';
import { CLOCK, type Clock } from '../../shared/clock/clock.js';
import { DatabaseService } from '../../shared/database/database.service.js';
import { AppError } from '../../shared/errors/app-error.js';
import { Mailer } from '../jobs/mailer.js';
import { toUserDto, type UserDto } from '../users/user.dto.js';
import { normalizeEmail, UsersService } from '../users/users.service.js';
import { hashPassword, isCommonPassword, verifyPassword } from './passwords.js';
import { type DeviceInfo, SessionsService, type SessionTokens } from './sessions.service.js';

export interface AuthResponse extends SessionTokens {
  user: UserDto;
}

export interface RegisterInput extends DeviceInfo {
  email: string;
  password: string;
  displayName?: string;
}

export interface LoginInput extends DeviceInfo {
  email: string;
  password: string;
}

const EMAIL_CODE_TTL_MS = 15 * 60 * 1000;
const EMAIL_CODE_MAX_ATTEMPTS = 5;
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

const invalidCredentials = (): AppError =>
  new AppError(401, 'AUTH_INVALID_CREDENTIALS', 'El correo o la contrasena no son correctos');

const invalidEmailCode = (): AppError =>
  new AppError(422, 'EMAIL_CODE_INVALID', 'El codigo no es valido o ya vencio');

const commonPassword = (field: string): AppError =>
  new AppError(422, 'VALIDATION_FAILED', 'La peticion no es valida', {
    errors: [
      {
        field,
        code: 'commonPassword',
        message: 'Esa contrasena es demasiado comun; elige otra',
      },
    ],
  });

@Injectable()
export class AuthService {
  /** Hash contra el que se verifica cuando el correo no existe, para tardar lo mismo que si existiera. */
  private readonly decoyHash = hashPassword(randomToken());

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(Mailer) private readonly mailer: Mailer,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  async register(input: RegisterInput): Promise<AuthResponse> {
    if (isCommonPassword(input.password)) {
      throw commonPassword('password');
    }
    const email = normalizeEmail(input.email);
    const alreadyRegistered = (): AppError =>
      new AppError(409, 'EMAIL_ALREADY_REGISTERED', 'Ya existe una cuenta con ese correo');

    if (await this.users.findActiveByEmail(email)) {
      throw alreadyRegistered();
    }
    let user: User;
    try {
      user = await this.database.client.user.create({
        data: {
          email,
          passwordHash: await hashPassword(input.password),
          displayName: input.displayName?.trim() || null,
        },
      });
    } catch (error) {
      // Dos registros simultaneos del mismo correo: el indice unico de la base decide.
      if ((error as { code?: string }).code === 'P2002') {
        throw alreadyRegistered();
      }
      throw error;
    }

    const tokens = await this.sessions.create(user.id, input);
    await this.sendVerificationCode(user);
    return { ...tokens, user: toUserDto(user) };
  }

  async login(input: LoginInput): Promise<AuthResponse> {
    const user = await this.users.findActiveByEmail(input.email);
    const passwordMatches = await verifyPassword(
      user?.passwordHash ?? (await this.decoyHash),
      input.password,
    );
    if (!user || !user.passwordHash || !passwordMatches) {
      throw invalidCredentials();
    }
    // El estado de la cuenta solo se revela a quien demostro conocer la contrasena.
    if (user.status !== 'ACTIVE') {
      throw accountSuspended();
    }
    const tokens = await this.sessions.create(user.id, input);
    return { ...tokens, user: toUserDto(user) };
  }

  async refresh(refreshToken: string): Promise<AuthResponse> {
    const { tokens, user } = await this.sessions.rotate(refreshToken);
    return { ...tokens, user: toUserDto(user) };
  }

  logout(sessionId: string): Promise<void> {
    return this.sessions.revoke(sessionId, 'LOGOUT');
  }

  logoutAll(userId: string): Promise<void> {
    return this.sessions.revokeAll(userId, 'LOGOUT_ALL');
  }

  async verifyEmail(userId: string, code: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw invalidEmailCode();
    }
    if (user.emailVerifiedAt) {
      return;
    }
    const now = this.clock.now();
    const current = await this.database.client.emailVerificationCode.findFirst({
      where: { userId, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (
      !current ||
      current.expiresAt.getTime() <= now.getTime() ||
      current.attempts >= EMAIL_CODE_MAX_ATTEMPTS
    ) {
      throw invalidEmailCode();
    }
    if (current.codeHash !== this.codeFingerprint(userId, code)) {
      await this.database.client.emailVerificationCode.update({
        where: { id: current.id },
        data: { attempts: { increment: 1 } },
      });
      throw invalidEmailCode();
    }
    await this.database.client.$transaction([
      this.database.client.emailVerificationCode.update({
        where: { id: current.id },
        data: { usedAt: now },
      }),
      this.database.client.user.update({
        where: { id: userId },
        data: { emailVerifiedAt: now, updatedAt: now },
      }),
    ]);
  }

  async resendVerification(userId: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (user && !user.emailVerifiedAt) {
      await this.sendVerificationCode(user);
    }
  }

  /** No revela si el correo existe: quien llama responde lo mismo en ambos casos. */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.users.findActiveByEmail(email);
    if (!user || user.status !== 'ACTIVE') {
      return;
    }
    const now = this.clock.now();
    const token = randomToken();
    await this.database.client.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hmacHex(this.env.jwtRefreshPepper, token),
        expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS),
        createdAt: now,
      },
    });
    await this.mailer.send({
      to: user.email,
      subject: 'Recupera tu contraseña de TrayectoIQ',
      text:
        'Recibimos un pedido para cambiar tu contraseña de TrayectoIQ.\n\n' +
        `Token: ${token}\n\n` +
        'Vence en 30 minutos y sirve una sola vez. Si no fuiste tú, ignora este correo.',
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    if (isCommonPassword(newPassword)) {
      throw commonPassword('newPassword');
    }
    const now = this.clock.now();
    const record = await this.database.client.passwordResetToken.findUnique({
      where: { tokenHash: hmacHex(this.env.jwtRefreshPepper, token) },
    });
    if (!record || record.usedAt || record.expiresAt.getTime() <= now.getTime()) {
      throw new AppError(422, 'VALIDATION_FAILED', 'La peticion no es valida', {
        errors: [{ field: 'token', code: 'invalid', message: 'El token no es valido o ya vencio' }],
      });
    }
    const passwordHash = await hashPassword(newPassword);
    // Marcar el token como usado va con condicion: si dos peticiones llegan a la vez, solo una gana.
    const claimed = await this.database.client.passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: now },
    });
    if (claimed.count === 0) {
      throw new AppError(422, 'VALIDATION_FAILED', 'La peticion no es valida', {
        errors: [{ field: 'token', code: 'invalid', message: 'El token no es valido o ya vencio' }],
      });
    }
    const user = await this.users.findById(record.userId);
    await this.database.client.user.update({
      where: { id: record.userId },
      data: {
        passwordHash,
        // Usar el token demuestra acceso al buzon, que es lo que la verificacion comprueba.
        emailVerifiedAt: user?.emailVerifiedAt ?? now,
        updatedAt: now,
      },
    });
    await this.sessions.revokeAll(record.userId, 'PASSWORD_RESET');
  }

  private async sendVerificationCode(user: User): Promise<void> {
    const now = this.clock.now();
    const code = randomDigits(6);
    await this.database.client.$transaction([
      // Un codigo nuevo invalida los anteriores.
      this.database.client.emailVerificationCode.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: now },
      }),
      this.database.client.emailVerificationCode.create({
        data: {
          userId: user.id,
          codeHash: this.codeFingerprint(user.id, code),
          expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS),
          createdAt: now,
        },
      }),
    ]);
    await this.mailer.send({
      to: user.email,
      subject: 'Tu código de verificación de TrayectoIQ',
      text: `Tu código de verificación de TrayectoIQ es ${code}.\n\nVence en 15 minutos.`,
    });
  }

  /** El codigo solo tiene 6 digitos: se liga al usuario para que una huella no sirva para otro. */
  private codeFingerprint(userId: string, code: string): string {
    return hmacHex(this.env.jwtRefreshPepper, `${userId}:${code}`);
  }
}
