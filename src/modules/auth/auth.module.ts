import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { OIDC_KEY_SETS, OidcVerifier, remoteKeySets } from './oidc-verifier.js';
import { SessionsService } from './sessions.service.js';

@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionsService,
    OidcVerifier,
    { provide: OIDC_KEY_SETS, useFactory: remoteKeySets },
  ],
})
export class AuthModule {}
