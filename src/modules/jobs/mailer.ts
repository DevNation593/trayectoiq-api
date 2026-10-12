import { Inject, Injectable } from '@nestjs/common';
import {
  EMAIL_SENDER,
  type EmailMessage,
  type EmailSender,
} from '../../shared/email/email-sender.js';
import { JOB_QUEUE, type JobQueue } from './job-queue.js';

const SEND_EMAIL = 'email.send';

/**
 * Envio de correo transaccional en segundo plano: la peticion que lo origina no espera al
 * proveedor ni falla si este falla; el trabajo se reintenta.
 */
@Injectable()
export class Mailer {
  constructor(
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    @Inject(EMAIL_SENDER) sender: EmailSender,
  ) {
    this.queue.register<EmailMessage>(SEND_EMAIL, (message) => sender.send(message));
  }

  send(message: EmailMessage): Promise<void> {
    return this.queue.enqueue(SEND_EMAIL, message);
  }
}
