// Ingest di un messaggio grezzo: parsing, salvataggio, threading, contatti, indice full-text.
// Vedi docs/02-system-design.md §6.1.

import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { convert as htmlToText } from 'html-to-text';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import type { Db } from '../db/client.ts';
import {
  attachments,
  contactAddresses,
  conversations,
  messageAddresses,
  messages,
  notes,
  resources,
  tasks,
  versionChains,
} from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';
import type { BlobStore } from '../store/blobs.ts';
import { cleanBody, makeSnippet, normalizeSubject } from './clean-text.ts';
import { detectNoise } from './noise.ts';
import { pendingFlagIntent, pendingSeenIntent } from '../activities/service.ts';
import { enqueueSummary } from '../ai/summarize.ts';
import { bus } from '../events/bus.ts';
import { enqueueEmbedding } from '../ai/embed.ts';
import { enqueueClassification } from '../ai/classify.ts';
import { clearReplySuggestion, completeReplyTasks, enqueueTaskExtraction } from '../ai/extract-tasks.ts';
import { clearActionSuggestions, enqueueActionSuggestion } from '../ai/suggest-actions.ts';
import { PRIORITY } from '../jobs/queue.ts';

export interface RawFetched {
  uid: number | null;
  mailbox: string | null;
  source: Buffer;
  flags: string[];
  labels: string[];
  gmMsgid?: string | null;
  gmThreadId?: string | null;
  internalDate?: Date | null;
}

export interface IngestContext {
  db: Db;
  sqlite: Database.Database;
  blobs: BlobStore;
}

export interface IngestResult {
  messageId: string;
  conversationId: string;
  created: boolean;
}

type Address = { name: string | null; email: string };

// Testo leggibile per snippet, riassunti ed embedding: niente immagini né URL dei link.
const HTML_TO_TEXT = {
  wordwrap: false as const,
  selectors: [
    { selector: 'img', format: 'skip' },
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'style', format: 'skip' },
  ],
};

export async function ingestMessage(
  ctx: IngestContext,
  account: { id: string; email: string },
  raw: RawFetched,
): Promise<IngestResult> {
  // 1. Già presente? (stesso X-GM-MSGID, oppure stesso Message-ID sull'account: es. inviato dall'app)
  const existing = findExisting(ctx.db, account.id, raw.gmMsgid ?? null, null);
  if (existing) {
    updateFlags(ctx.db, existing.id, raw);
    return { messageId: existing.id, conversationId: existing.conversationId, created: false };
  }

  const parsed = await simpleParser(raw.source, { skipTextToHtml: true, skipImageLinks: true });
  const rfcMessageId = cleanId(parsed.messageId);

  const byRfc = rfcMessageId ? findExisting(ctx.db, account.id, null, rfcMessageId) : undefined;
  if (byRfc) {
    updateFlags(ctx.db, byRfc.id, raw);
    return { messageId: byRfc.id, conversationId: byRfc.conversationId, created: false };
  }

  // 2. Contenuto (I/O su disco fuori dalla transazione)
  const rawSha = ctx.blobs.put(raw.source, 'message/rfc822');
  const html = typeof parsed.html === 'string' ? parsed.html : null;
  const htmlSha = html ? ctx.blobs.put(Buffer.from(html, 'utf8'), 'text/html') : null;
  const bodyText = parsed.text?.trim() ? parsed.text : html ? htmlToText(html, HTML_TO_TEXT) : '';
  const bodyTextClean = cleanBody(bodyText);
  const atts = parsed.attachments.map((a) => ({
    sha: ctx.blobs.put(a.content, a.contentType),
    filename: a.filename ?? null,
    mime: a.contentType,
    size: a.size,
    contentId: a.cid ?? null,
    isInline: a.contentDisposition === 'inline' && !!a.cid,
  }));

  const from = addressesOf(parsed.from)[0] ?? null;
  const to = addressesOf(parsed.to);
  const cc = addressesOf(parsed.cc);
  const bcc = addressesOf(parsed.bcc);
  const direction =
    raw.labels.includes('\\Sent') || (from && from.email === account.email.toLowerCase()) ? 'out' : 'in';
  const date = (parsed.date ?? raw.internalDate ?? new Date()).getTime();
  const inReplyTo = cleanId(parsed.inReplyTo);
  const references = referencesOf(parsed);
  const t = now();

  // 3. Scrittura atomica
  const result = ctx.db.transaction((tx) => {
    const conversationId = resolveConversation(tx as unknown as Db, {
      gmThreadId: raw.gmThreadId ?? null,
      rfcMessageId,
      parentIds: [...new Set([inReplyTo, ...references].filter((x): x is string => !!x))],
      subject: parsed.subject ?? null,
      date,
      noise: () => detectNoise({ headers: parsed.headers, fromAddress: from?.email ?? null }).isNoise,
    });

    const messageId = newId();
    tx.insert(messages)
      .values({
        id: messageId,
        conversationId,
        accountId: account.id,
        direction,
        rfcMessageId,
        inReplyTo,
        references: JSON.stringify(references),
        gmMsgid: raw.gmMsgid ?? null,
        gmThreadId: raw.gmThreadId ?? null,
        mailbox: raw.mailbox,
        uid: raw.uid,
        fromAddress: from?.email ?? null,
        fromName: from?.name ?? null,
        subject: parsed.subject ?? null,
        date,
        snippet: makeSnippet(bodyTextClean || bodyText),
        bodyText,
        bodyTextClean,
        rawBlobSha: rawSha,
        htmlBlobSha: htmlSha,
        flags: JSON.stringify(raw.flags),
        labels: JSON.stringify(raw.labels),
        seen: raw.flags.includes('\\Seen'),
        important: raw.flags.includes('\\Flagged'),
        hasAttachments: atts.some((a) => !a.isInline),
        createdAt: t,
        updatedAt: t,
      })
      .run();

    for (const a of atts) {
      tx.insert(attachments)
        .values({
          id: newId(),
          messageId,
          blobSha: a.sha,
          filename: a.filename,
          mime: a.mime,
          size: a.size,
          contentId: a.contentId,
          isInline: a.isInline,
          createdAt: t,
        })
        .run();
    }

    const roles: [Address[], 'from' | 'to' | 'cc' | 'bcc'][] = [
      [from ? [from] : [], 'from'],
      [to, 'to'],
      [cc, 'cc'],
      [bcc, 'bcc'],
    ];
    for (const [list, role] of roles) {
      for (const addr of list) {
        const addressId = upsertAddress(tx as unknown as Db, addr, date);
        tx.insert(messageAddresses).values({ messageId, contactAddressId: addressId, role }).onConflictDoNothing().run();
      }
    }

    ctx.sqlite
      .prepare('insert into message_fts(message_id, subject, body, participants) values (?, ?, ?, ?)')
      .run(
        messageId,
        parsed.subject ?? '',
        bodyTextClean || bodyText,
        [from, ...to, ...cc].filter(Boolean).map((a) => `${a!.name ?? ''} ${a!.email}`).join(' '),
      );

    tx.update(conversations)
      .set({
        lastMessageAt: sql`max(${conversations.lastMessageAt}, ${date})`,
        // Posta nuova in arrivo riporta in vista una conversazione archiviata o cestinata (come Gmail).
        ...(direction === 'in' ? { archivedAt: null, trashedAt: null } : {}),
        updatedAt: t,
      })
      .where(eq(conversations.id, conversationId))
      .run();

    return { messageId, conversationId, created: true };
  });

  // Lavori in background (non per il rumore): sintesi, embedding e, se è in Da smistare, classificazione.
  // La posta vecchia (backfill) va in coda con priorità bassa.
  const conv = ctx.db
    .select({ isNoise: conversations.isNoise, projectId: conversations.projectId })
    .from(conversations)
    .where(eq(conversations.id, result.conversationId))
    .get();
  if (conv && !conv.isNoise) {
    const priority = date > Date.now() - 30 * 86_400_000 ? PRIORITY.normal : PRIORITY.background;
    enqueueEmbedding(ctx.db, result.messageId, priority);
    enqueueSummary(ctx.db, result.conversationId, priority);
    if (!conv.projectId) enqueueClassification(ctx.db, result.conversationId, priority);
    // Task suggeriti solo dalla posta in arrivo recente: dallo storico sarebbero rumore.
    if (priority === PRIORITY.normal && direction === 'in') {
      // Prima la valutazione (rispondi/archivia/rumore): se il messaggio non chiede nulla, i task si saltano.
      enqueueActionSuggestion(ctx.db, result.messageId);
      enqueueTaskExtraction(ctx.db, result.messageId);
    }
  }
  // Una risposta (anche da Gmail o dal telefono) chiude "rispondere" (suggerimenti e task) e le azioni proposte.
  if (direction === 'out') {
    const cleared = clearReplySuggestion(ctx.db, result.conversationId);
    const actions = clearActionSuggestions(ctx.db, result.conversationId);
    const done = completeReplyTasks(ctx.db, result.conversationId, date);
    if (cleared || actions || done) bus.publish({ type: 'conversations', ids: [result.conversationId] });
  }
  return result;
}

// ─── Threading ───────────────────────────────────────────────────────────────

interface ThreadKeys {
  gmThreadId: string | null;
  rfcMessageId: string | null;
  parentIds: string[];
  subject: string | null;
  date: number;
  noise: () => boolean;
}

/**
 * Ordine: thread Gmail → Message-ID dei genitori (In-Reply-To/References) → figli arrivati prima
 * (backfill fuori ordine). Se più conversazioni risultano collegate, vengono unite.
 * Nessun aggancio per solo oggetto: rischia di unire conversazioni diverse.
 */
function resolveConversation(db: Db, k: ThreadKeys): string {
  const candidates = new Set<string>();

  if (k.gmThreadId) {
    for (const c of db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.gmThreadId, k.gmThreadId), isNull(conversations.deletedAt)))
      .all())
      candidates.add(c.id);
  }

  if (k.parentIds.length) {
    for (const m of db
      .select({ c: messages.conversationId })
      .from(messages)
      .where(and(inArray(messages.rfcMessageId, k.parentIds), isNull(messages.deletedAt)))
      .all())
      candidates.add(m.c);
  }

  if (k.rfcMessageId) {
    for (const m of db
      .select({ c: messages.conversationId })
      .from(messages)
      .where(
        and(
          or(
            eq(messages.inReplyTo, k.rfcMessageId),
            sql`exists (select 1 from json_each(${messages.references}) where value = ${k.rfcMessageId})`,
          ),
          isNull(messages.deletedAt),
        ),
      )
      .all())
      candidates.add(m.c);
  }

  const t = now();
  if (candidates.size === 0) {
    const id = newId();
    db.insert(conversations)
      .values({
        id,
        projectId: null,
        subject: normalizeSubject(k.subject) || null,
        lastMessageAt: k.date,
        gmThreadId: k.gmThreadId,
        isNoise: k.noise(),
        createdAt: t,
        updatedAt: t,
      })
      .run();
    return id;
  }

  const target = candidates.size === 1 ? [...candidates][0]! : mergeConversations(db, [...candidates]);
  if (k.gmThreadId) {
    db.update(conversations)
      .set({ gmThreadId: k.gmThreadId })
      .where(and(eq(conversations.id, target), isNull(conversations.gmThreadId)))
      .run();
  }
  return target;
}

/** Unisce più conversazioni in una: tiene quella con un progetto, altrimenti la più vecchia. */
export function mergeConversations(db: Db, ids: string[]): string {
  const rows = db.select().from(conversations).where(inArray(conversations.id, ids)).all();
  rows.sort((a, b) => Number(!!b.projectId) - Number(!!a.projectId) || a.createdAt - b.createdAt);
  const target = rows[0]!;
  const others = rows.slice(1).map((r) => r.id);
  if (!others.length) return target.id;
  const t = now();

  db.update(messages).set({ conversationId: target.id }).where(inArray(messages.conversationId, others)).run();
  db.update(notes).set({ conversationId: target.id }).where(inArray(notes.conversationId, others)).run();
  db.update(tasks).set({ conversationId: target.id }).where(inArray(tasks.conversationId, others)).run();
  db.update(resources).set({ conversationId: target.id }).where(inArray(resources.conversationId, others)).run();
  db.update(versionChains).set({ conversationId: target.id }).where(inArray(versionChains.conversationId, others)).run();
  db.update(conversations)
    .set({
      lastMessageAt: Math.max(...rows.map((r) => r.lastMessageAt)),
      // Il rumore resta tale solo se lo erano tutte.
      isNoise: rows.every((r) => r.isNoise),
      subject: target.subject ?? rows.find((r) => r.subject)?.subject ?? null,
      updatedAt: t,
    })
    .where(eq(conversations.id, target.id))
    .run();
  db.update(conversations).set({ deletedAt: t, updatedAt: t }).where(inArray(conversations.id, others)).run();
  return target.id;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findExisting(db: Db, accountId: string, gmMsgid: string | null, rfcMessageId: string | null) {
  if (!gmMsgid && !rfcMessageId) return undefined;
  return db
    .select({ id: messages.id, conversationId: messages.conversationId })
    .from(messages)
    .where(
      and(
        eq(messages.accountId, accountId),
        gmMsgid ? eq(messages.gmMsgid, gmMsgid) : eq(messages.rfcMessageId, rfcMessageId!),
        isNull(messages.deletedAt),
      ),
    )
    .get();
}

export function updateFlags(
  db: Db,
  messageId: string,
  raw: Pick<RawFetched, 'flags' | 'labels' | 'uid' | 'mailbox' | 'gmMsgid'> & { gmThreadId?: string | null },
) {
  // Un "letto/non letto" ancora in coda prevale sullo stato del server, che non è ancora aggiornato.
  const intent = pendingSeenIntent(db, [messageId]).get(messageId);
  const importantIntent = pendingFlagIntent(db, [messageId], '\\Flagged').get(messageId);
  const t = now();
  db.update(messages)
    .set({
      flags: JSON.stringify(raw.flags),
      labels: JSON.stringify(raw.labels),
      seen: intent ?? raw.flags.includes('\\Seen'),
      important: importantIntent ?? raw.flags.includes('\\Flagged'),
      ...(raw.uid != null ? { uid: raw.uid, mailbox: raw.mailbox } : {}),
      ...(raw.gmMsgid ? { gmMsgid: raw.gmMsgid } : {}),
      ...(raw.gmThreadId ? { gmThreadId: raw.gmThreadId } : {}),
      updatedAt: t,
    })
    .where(eq(messages.id, messageId))
    .run();
  if (raw.gmThreadId) {
    // Email scritta dall'app e ritrovata sul server: la conversazione eredita il thread Gmail.
    const msg = db.select({ c: messages.conversationId }).from(messages).where(eq(messages.id, messageId)).get();
    if (msg) {
      db.update(conversations)
        .set({ gmThreadId: raw.gmThreadId })
        .where(and(eq(conversations.id, msg.c), isNull(conversations.gmThreadId)))
        .run();
    }
  }
}

export function upsertAddress(db: Db, addr: Address, seenAt: number): string {
  const existing = db.select().from(contactAddresses).where(eq(contactAddresses.email, addr.email)).get();
  const t = now();
  if (existing) {
    db.update(contactAddresses)
      .set({
        displayName: existing.displayName ?? addr.name,
        lastSeenAt: Math.max(existing.lastSeenAt ?? 0, seenAt),
        updatedAt: t,
      })
      .where(eq(contactAddresses.id, existing.id))
      .run();
    return existing.id;
  }
  const id = newId();
  db.insert(contactAddresses)
    .values({ id, contactId: null, email: addr.email, displayName: addr.name, lastSeenAt: seenAt, createdAt: t, updatedAt: t })
    .run();
  return id;
}

function addressesOf(field: AddressObject | AddressObject[] | undefined): Address[] {
  if (!field) return [];
  const out: Address[] = [];
  const walk = (list: AddressObject['value']) => {
    for (const a of list) {
      if (a.group) walk(a.group);
      else if (a.address) out.push({ name: a.name?.trim() || null, email: a.address.trim().toLowerCase() });
    }
  };
  for (const f of Array.isArray(field) ? field : [field]) walk(f.value);
  return out;
}

function cleanId(id: string | undefined | null): string | null {
  const v = id?.trim();
  return v ? v : null;
}

function referencesOf(parsed: ParsedMail): string[] {
  const r = parsed.references;
  if (!r) return [];
  return (Array.isArray(r) ? r : r.split(/\s+/)).map((x) => x.trim()).filter(Boolean);
}
