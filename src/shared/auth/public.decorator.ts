import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'tiq:isPublic';

/**
 * Marca un controlador o un metodo como accesible sin bearer. Todo lo demas exige sesion:
 * el guard de autenticacion es global y la proteccion es el comportamiento por defecto.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
