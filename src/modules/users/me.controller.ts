import { Controller, Get, Inject } from '@nestjs/common';
import { sessionExpired } from '../../shared/auth/access-tokens.js';
import { type AuthContext, CurrentAuth } from '../../shared/auth/auth-context.js';
import { Operation } from '../../shared/contract/contract.guard.js';
import { toUserDto, type UserDto } from './user.dto.js';
import { UsersService } from './users.service.js';

@Controller('me')
export class MeController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get()
  @Operation('getMe')
  async getMe(@CurrentAuth() auth: AuthContext): Promise<UserDto> {
    const user = await this.users.findById(auth.userId);
    if (!user) {
      throw sessionExpired();
    }
    return toUserDto(user);
  }
}
