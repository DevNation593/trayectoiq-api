export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Envio de correo transaccional. Lanza si el proveedor no lo acepto: el job que lo llama reintenta. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
