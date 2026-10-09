import type { MessageDto } from '@mmw/shared';
import type { ComposeRequest } from '../workspace/pane.ts';
import { paths } from '../shell/paths.ts';

/** Come nasce una bozza non ancora salvata (passato nello stato della navigazione). */
export interface DraftSeed {
  replyToMessageId?: string;
  replyAll?: boolean;
  forwardMessageId?: string;
  to?: string[];
  subject?: string;
  /** Testo proposto dall'analizzatore. */
  body?: string;
  projectId?: string | null;
}

/** Bozza non ancora salvata: si crea sul server alla prima modifica. */
export const NEW_DRAFT = 'new';

export function seedOf(r: ComposeRequest): DraftSeed {
  return {
    replyToMessageId: r.replyTo?.id,
    replyAll: r.replyAll,
    forwardMessageId: r.forward?.id,
    to: r.to,
    subject: r.forward ? `Fwd: ${normalizeSubject(r.forward.subject)}` : undefined,
    body: r.draft,
    projectId: r.projectId,
  };
}

/** Dove porta una richiesta di scrittura: nel carosello della conversazione o una nuova mail. */
export function composeTarget(projectKey: string, r: ComposeRequest): string {
  if (r.conversationId && !r.forward) return paths.draft(projectKey, r.conversationId, NEW_DRAFT);
  return paths.newMail(r.projectId ?? projectKey, NEW_DRAFT);
}

export function normalizeSubject(s: string | null | undefined): string {
  return (s ?? '').replace(/^(\s*(re|r|fwd?|i|inoltra|aw|sv|tr)\s*(\[\d+\])?\s*:\s*)+/i, '').trim();
}

/** Destinatari di una risposta. A un messaggio mio si riscrive agli stessi destinatari. */
export function replyRecipients(m: MessageDto, all: boolean, isMe: (email: string) => boolean) {
  const to = m.direction === 'out' ? m.to.map((p) => p.email) : m.from ? [m.from.email] : [];
  const cc = all ? [...m.to, ...m.cc].map((p) => p.email).filter((e) => !isMe(e) && !to.includes(e)) : [];
  return { to, cc: [...new Set(cc)] };
}
