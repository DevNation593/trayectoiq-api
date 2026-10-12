import type { User } from '../../generated/prisma/client.js';

/** Esquema User de openapi.yaml. */
export interface UserDto {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  role: 'USER' | 'SUPPORT' | 'ADMIN';
  countryCode: string;
  currency: string;
  timezone: string;
}

export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    displayName: user.displayName,
    role: user.role,
    countryCode: user.countryCode,
    currency: user.currency,
    timezone: user.timezone,
  };
}
