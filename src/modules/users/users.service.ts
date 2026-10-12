import { Inject, Injectable } from '@nestjs/common';
import type { User } from '../../generated/prisma/client.js';
import { DatabaseService } from '../../shared/database/database.service.js';

/** Los correos se guardan y se buscan siempre recortados y en minusculas. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

@Injectable()
export class UsersService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  findById(id: string): Promise<User | null> {
    return this.database.client.user.findUnique({ where: { id } });
  }

  /** Cuenta no eliminada con ese correo. El indice unico de la base no distingue mayusculas. */
  findActiveByEmail(email: string): Promise<User | null> {
    return this.database.client.user.findFirst({
      where: { email: normalizeEmail(email), deletedAt: null },
    });
  }
}
