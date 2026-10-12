import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'tiq:isPublic';

/**
 * Marca un controlador o un metodo como accesible sin bearer. Todo lo demas exige sesion:
 * el guard de autenticacion es global y la proteccion es el comportamiento por defecto.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

export const OPTIONAL_AUTH = 'optional';

/**
 * Ruta accesible sin bearer que, si llega uno valido, sabe quien la llama. Un bearer vencido o
 * invalido no es un error aqui: la peticion sigue como anonima.
 */
export const OptionalAuth = (): MethodDecorator => SetMetadata(IS_PUBLIC, OPTIONAL_AUTH);
