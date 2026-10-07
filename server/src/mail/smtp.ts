import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { AccountDto } from '@mmw/shared';
import { resolveSecret } from './credentials.ts';

export interface OutgoingMessage {
  from: { name: string | null; email: string };
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  date: Date;
}

/**
 * Costruisce il MIME una volta sola: lo stesso buffer va all'SMTP e, se serve, in Inviati.
 * MailComposer non scrive l'header Bcc: i destinatari nascosti restano solo nella busta SMTP.
 */
export async function buildMime(msg: OutgoingMessage): Promise<Buffer> {
  const composer = new MailComposer({
    from: msg.from.name ? { name: msg.from.name, address: msg.from.email } : msg.from.email,
    to: msg.to,
    cc: msg.cc.length ? msg.cc : undefined,
    bcc: msg.bcc.length ? msg.bcc : undefined,
    subject: msg.subject,
    text: msg.text,
    messageId: msg.messageId,
    inReplyTo: msg.inReplyTo ?? undefined,
    references: msg.references?.length ? msg.references : undefined,
    date: msg.date,
  });
  return composer.compile().build();
}

export type SmtpSender = (account: AccountDto, raw: Buffer, envelope: { from: string; to: string[] }) => Promise<void>;

export const sendViaSmtp: SmtpSender = async (account, raw, envelope) => {
  if (account.authType !== 'password') throw new Error('OAuth2 non ancora supportato per SMTP');
  const transport = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpSecure,
    auth: { user: account.username, pass: resolveSecret(account.credentialRef).replace(/\s+/g, '') },
  });
  try {
    await transport.sendMail({ envelope, raw });
  } finally {
    transport.close();
  }
};
