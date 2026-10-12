import type { EmailMessage, EmailSender } from './email-sender.js';

/** Guarda los correos en memoria para que los tests lean, por ejemplo, el codigo de verificacion. */
export class FakeEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  private failures = 0;

  /** Los proximos `count` envios fallan; despues vuelve a funcionar. */
  failNext(count = 1): void {
    this.failures = count;
  }

  send(message: EmailMessage): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error('Fallo simulado del proveedor de correo'));
    }
    this.sent.push(message);
    return Promise.resolve();
  }

  /** El ultimo correo enviado a esa direccion. */
  lastTo(address: string): EmailMessage | undefined {
    return this.sent.findLast((message) => message.to.toLowerCase() === address.toLowerCase());
  }
}
