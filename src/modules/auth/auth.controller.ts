import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { type AuthContext, CurrentAuth } from '../../shared/auth/auth-context.js';
import { Public } from '../../shared/auth/public.decorator.js';
import { Operation } from '../../shared/contract/contract.guard.js';
import { RateLimit } from '../../shared/rate-limit/rate-limit.guard.js';
import {
  type AuthResponse,
  AuthService,
  type LoginInput,
  type RegisterInput,
} from './auth.service.js';

/** Los cuerpos llegan ya validados contra openapi.yaml por ContractGuard. */
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @Operation('register')
  @RateLimit('register')
  register(@Body() body: RegisterInput): Promise<AuthResponse> {
    return this.auth.register(body);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Operation('login')
  @RateLimit('login')
  login(@Body() body: LoginInput): Promise<AuthResponse> {
    return this.auth.login(body);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Operation('refreshSession')
  refresh(@Body() body: { refreshToken: string }): Promise<AuthResponse> {
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Operation('logout')
  logout(@CurrentAuth() auth: AuthContext): Promise<void> {
    return this.auth.logout(auth.sessionId);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Operation('logoutAll')
  logoutAll(@CurrentAuth() auth: AuthContext): Promise<void> {
    return this.auth.logoutAll(auth.userId);
  }

  @Post('email/verify')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Operation('verifyEmail')
  verifyEmail(@CurrentAuth() auth: AuthContext, @Body() body: { code: string }): Promise<void> {
    return this.auth.verifyEmail(auth.userId, body.code);
  }

  @Post('email/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @Operation('resendEmailVerification')
  @RateLimit('emailCode')
  resendVerification(@CurrentAuth() auth: AuthContext): Promise<void> {
    return this.auth.resendVerification(auth.userId);
  }

  @Public()
  @Post('password/forgot')
  @HttpCode(HttpStatus.ACCEPTED)
  @Operation('forgotPassword')
  @RateLimit('emailCode')
  forgotPassword(@Body() body: { email: string }): Promise<void> {
    return this.auth.forgotPassword(body.email);
  }

  @Public()
  @Post('password/reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Operation('resetPassword')
  resetPassword(@Body() body: { token: string; newPassword: string }): Promise<void> {
    return this.auth.resetPassword(body.token, body.newPassword);
  }
}
