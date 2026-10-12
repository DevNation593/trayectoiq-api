import { createTransport, type Transporter } from 'nodemailer';
import type { EmailMessage, EmailSender } from './email-sender.js';

/** Correo por SMTP: Mailpit en local y el proveedor transaccional que se elija en produccion. */
export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = createTransport({
      url: smtpUrl,
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}
