// Schema del database. Vedi docs/02-system-design.md §5.
//
// Convenzioni:
// - ID: ULID (text).
// - Timestamp: millisecondi epoch (integer).
// - Le entità applicative hanno created_at / updated_at / deleted_at (tombstone)
//   per predisporre la sincronizzazione cloud futura.
// - Il progetto di un messaggio NON è salvato sul messaggio: si ricava sempre da
//   conversations.project_id, così tutte le email di una conversazione stanno
//   nello stesso progetto per costruzione.
//
// Le tabelle virtuali (FTS5, sqlite-vec) sono create in una migrazione SQL custom.

import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const meta = () => ({
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
});

// ─── Account e sync ──────────────────────────────────────────────────────────

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  provider: text('provider', { enum: ['gmail', 'imap'] }).notNull(),
  imapHost: text('imap_host').notNull(),
  imapPort: integer('imap_port').notNull(),
  imapSecure: integer('imap_secure', { mode: 'boolean' }).notNull(),
  smtpHost: text('smtp_host').notNull(),
  smtpPort: integer('smtp_port').notNull(),
  smtpSecure: integer('smtp_secure', { mode: 'boolean' }).notNull(),
  username: text('username').notNull(),
  authType: text('auth_type', { enum: ['password', 'oauth2'] }).notNull(),
  credentialRef: text('credential_ref').notNull(),
  color: text('color'),
  ...meta(),
});

/** Firme definite nelle impostazioni; ogni progetto ne sceglie una (o nessuna). */
export const signatures = sqliteTable('signatures', {
  id: text('id').primaryKey(),
  /** Nome con cui la si sceglie ("Lavoro", "Personale"). */
  label: text('label').notNull(),
  /** HTML dall'editor e sua versione in testo semplice. */
  html: text('html').notNull(),
  text: text('text').notNull(),
  ...meta(),
});

export const syncState = sqliteTable(
  'sync_state',
  {
    accountId: text('account_id').notNull().references(() => accounts.id),
    mailbox: text('mailbox').notNull(),
    uidValidity: text('uid_validity'),
    lastUid: integer('last_uid'),
    /** UID più basso già importato: il backfill prosegue da qui verso il basso. */
    lowestUid: integer('lowest_uid'),
    highestModseq: text('highest_modseq'),
    oldestSyncedDate: integer('oldest_synced_date'),
    backfillDone: integer('backfill_done', { mode: 'boolean' }).notNull().default(false),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.mailbox] })],
);

// ─── Progetti e conversazioni ────────────────────────────────────────────────

/** Categorie della barra dei progetti (Personale, Lavoro…): servono solo a ordinare. */
export const projectCategories = sqliteTable('project_categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Ordine nella barra (indice frazionario). */
  rank: text('rank'),
  /** Chiusa nella barra laterale: i suoi progetti non si vedono, gli indicatori salgono sulla riga. */
  collapsed: integer('collapsed', { mode: 'boolean' }).notNull().default(false),
  ...meta(),
});

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  outgoingAccountId: text('outgoing_account_id').notNull().references(() => accounts.id),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  color: text('color'),
  /** Firma delle mail del progetto; NULL = nessuna. */
  signatureId: text('signature_id'),
  /** Ordine nella barra dei progetti (indice frazionario); NULL = in fondo, per nome. */
  rank: text('rank'),
  /** NULL = "Senza categoria". */
  categoryId: text('category_id').references(() => projectCategories.id),
  ...meta(),
});

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    /** NULL = "Da smistare". */
    projectId: text('project_id').references(() => projects.id),
    subject: text('subject'),
    /** Sintesi breve (una riga), generata dall'LLM a ogni nuovo messaggio. */
    summary: text('summary'),
    /** Sintesi un po' più dettagliata (4-5 righe), mostrata espandendo la conversazione. */
    summaryDetailed: text('summary_detailed'),
    summaryUpdatedAt: integer('summary_updated_at'),
    lastMessageAt: integer('last_message_at').notNull(),
    gmThreadId: text('gm_thread_id'),
    /** Newsletter/notifiche: escluse da Da smistare, embedding e task. */
    isNoise: integer('is_noise', { mode: 'boolean' }).notNull().default(false),
    /** Ultima classificazione (progetto suggerito); NULL = da (ri)classificare. */
    classifiedAt: integer('classified_at'),
    /** Archiviata: nascosta dalle viste salvo filtro. Riappare se arriva un nuovo messaggio. */
    archivedAt: integer('archived_at'),
    /** Nel cestino (anche su Gmail, tramite coda attività). */
    trashedAt: integer('trashed_at'),
    /**
     * Conversazione da cui è stata staccata a mano (RF-C5). Le due non si riuniscono più da sole:
     * una risposta va dove sta il messaggio a cui risponde direttamente.
     */
    splitFromId: text('split_from_id'),
    /** Quando è stata staccata: fino a un messaggio più recente sta in cima alla lista. */
    splitAt: integer('split_at'),
    /** Smistata da sola (RF-E6): segno "smistata automaticamente · Annulla" finché non la si apre. */
    autoSortedAt: integer('auto_sorted_at'),
    /** News sì/no deciso a mano dall'utente: le rivalutazioni automatiche non lo toccano. */
    noiseManual: integer('noise_manual', { mode: 'boolean' }).notNull().default(false),
    /** Spam (deciso dall'utente o da una sua regola): visibile solo nella vista Spam. */
    isSpam: integer('is_spam', { mode: 'boolean' }).notNull().default(false),
    ...meta(),
  },
  (t) => [
    index('conversations_project_last').on(t.projectId, t.lastMessageAt),
    index('conversations_gm_thread').on(t.gmThreadId),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull().references(() => conversations.id),
    accountId: text('account_id').notNull().references(() => accounts.id),
    direction: text('direction', { enum: ['in', 'out'] }).notNull(),
    rfcMessageId: text('rfc_message_id'),
    inReplyTo: text('in_reply_to'),
    /** JSON: string[] dell'header References. */
    references: text('references'),
    gmMsgid: text('gm_msgid'),
    gmThreadId: text('gm_thread_id'),
    mailbox: text('mailbox'),
    uid: integer('uid'),
    fromAddress: text('from_address'),
    fromName: text('from_name'),
    subject: text('subject'),
    date: integer('date').notNull(),
    snippet: text('snippet'),
    bodyText: text('body_text'),
    /** Testo senza parti quotate e firma: base per embedding e riassunti. */
    bodyTextClean: text('body_text_clean'),
    rawBlobSha: text('raw_blob_sha'),
    htmlBlobSha: text('html_blob_sha'),
    /** JSON: string[] dei flag IMAP. */
    flags: text('flags'),
    /** JSON: string[] delle etichette Gmail (X-GM-LABELS). */
    labels: text('labels'),
    seen: integer('seen', { mode: 'boolean' }).notNull().default(false),
    /** Segnalibro "Importante" (D16), sincronizzato con il flag \\Flagged (le "Speciali" di Gmail). */
    important: integer('important', { mode: 'boolean' }).notNull().default(false),
    hasAttachments: integer('has_attachments', { mode: 'boolean' }).notNull().default(false),
    analyzedAt: integer('analyzed_at'),
    /** Solo per i messaggi scritti nell'app: stato dell'invio tramite coda attività. */
    outgoingStatus: text('outgoing_status', { enum: ['queued', 'sent', 'failed'] }),
    ...meta(),
  },
  (t) => [
    index('messages_conversation_date').on(t.conversationId, t.date),
    index('messages_rfc_id').on(t.rfcMessageId),
    uniqueIndex('messages_account_gm_msgid').on(t.accountId, t.gmMsgid),
    index('messages_account_mailbox_uid').on(t.accountId, t.mailbox, t.uid),
    // Indici "snelli": la tabella è grande (contiene il testo delle mail) e contare scorrendola tutta
    // costa secondi. Questi contengono solo le informazioni chiave delle righe che servono.
    // Non letti per progetto e per vista (barra laterale, contatori).
    index('messages_unread').on(t.conversationId).where(sql`seen = 0 and direction = 'in' and deleted_at is null`),
    // Conversazioni con messaggi importanti (vista Importanti e suo conteggio).
    index('messages_important').on(t.conversationId).where(sql`important = 1 and deleted_at is null`),
    // Da messaggio a conversazione e data senza leggere la riga intera (rubrica, persone).
    index('messages_slim').on(t.id, t.conversationId, t.date).where(sql`deleted_at is null`),
  ],
);

// ─── Contatti e gruppi ───────────────────────────────────────────────────────

export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  avatarBlobSha: text('avatar_blob_sha'),
  notes: text('notes'),
  ...meta(),
});

export const contactAddresses = sqliteTable(
  'contact_addresses',
  {
    id: text('id').primaryKey(),
    /** NULL = indirizzo visto ma non ancora associato a un contatto. */
    contactId: text('contact_id').references(() => contacts.id),
    email: text('email').notNull(),
    displayName: text('display_name'),
    lastSeenAt: integer('last_seen_at'),
    ...meta(),
  },
  (t) => [uniqueIndex('contact_addresses_email').on(t.email), index('contact_addresses_contact').on(t.contactId)],
);

export const messageAddresses = sqliteTable(
  'message_addresses',
  {
    messageId: text('message_id').notNull().references(() => messages.id),
    contactAddressId: text('contact_address_id').notNull().references(() => contactAddresses.id),
    role: text('role', { enum: ['from', 'to', 'cc', 'bcc'] }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.contactAddressId, t.role] }),
    index('message_addresses_address').on(t.contactAddressId),
  ],
);

export const contactGroups = sqliteTable('contact_groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ...meta(),
});

export const groupMembers = sqliteTable(
  'group_members',
  {
    groupId: text('group_id').notNull().references(() => contactGroups.id),
    contactId: text('contact_id').notNull().references(() => contacts.id),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.contactId] })],
);

/** Contatti associati esplicitamente a un progetto (oltre a quelli che vi compaiono nelle email). */
export const projectContacts = sqliteTable(
  'project_contacts',
  {
    projectId: text('project_id').notNull().references(() => projects.id),
    contactId: text('contact_id').notNull().references(() => contacts.id),
    /** Ordine nella barra contatti del progetto. */
    rank: text('rank'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.contactId] })],
);

/** Gruppi associati a un progetto (scorciatoia per scrivere a tutti i membri). */
export const projectGroups = sqliteTable(
  'project_groups',
  {
    projectId: text('project_id').notNull().references(() => projects.id),
    groupId: text('group_id').notNull().references(() => contactGroups.id),
    /** Ordine nella barra contatti del progetto. */
    rank: text('rank'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.groupId] })],
);

// ─── Allegati, risorse, versioni ─────────────────────────────────────────────

/** Storage content-addressed: il file sta in data/blobs/<sha[0:2]>/<sha>. */
export const blobs = sqliteTable('blobs', {
  sha256: text('sha256').primaryKey(),
  size: integer('size').notNull(),
  mime: text('mime'),
  createdAt: integer('created_at').notNull(),
});

export const versionChains = sqliteTable('version_chains', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id),
  logicalName: text('logical_name').notNull(),
  ...meta(),
});

export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').notNull().references(() => messages.id),
    blobSha: text('blob_sha').notNull().references(() => blobs.sha256),
    filename: text('filename'),
    mime: text('mime'),
    size: integer('size').notNull(),
    contentId: text('content_id'),
    isInline: integer('is_inline', { mode: 'boolean' }).notNull().default(false),
    versionChainId: text('version_chain_id').references(() => versionChains.id),
    versionNo: integer('version_no'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('attachments_message').on(t.messageId), index('attachments_chain').on(t.versionChainId)],
);

export const resources = sqliteTable(
  'resources',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id),
    conversationId: text('conversation_id').references(() => conversations.id),
    kind: text('kind', { enum: ['file', 'link'] }).notNull(),
    blobSha: text('blob_sha').references(() => blobs.sha256),
    url: text('url'),
    title: text('title').notNull(),
    ...meta(),
  },
  (t) => [index('resources_project').on(t.projectId)],
);

// ─── Note, annotazioni, task ─────────────────────────────────────────────────

/** Ancoraggio stile W3C Web Annotation (TextQuoteSelector + TextPositionSelector). */
export const annotations = sqliteTable(
  'annotations',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').notNull().references(() => messages.id),
    quoteExact: text('quote_exact').notNull(),
    quotePrefix: text('quote_prefix'),
    quoteSuffix: text('quote_suffix'),
    startOffset: integer('start_offset'),
    endOffset: integer('end_offset'),
    label: text('label'),
    comment: text('comment'),
    ...meta(),
  },
  (t) => [index('annotations_message').on(t.messageId)],
);

export const notes = sqliteTable(
  'notes',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id),
    conversationId: text('conversation_id').references(() => conversations.id),
    annotationId: text('annotation_id').references(() => annotations.id),
    /** Messaggio da cui è nata la nota (la "fonte"). */
    messageId: text('message_id').references(() => messages.id),
    body: text('body').notNull(),
    ...meta(),
  },
  (t) => [index('notes_project').on(t.projectId), index('notes_conversation').on(t.conversationId)],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id),
    conversationId: text('conversation_id').references(() => conversations.id),
    messageId: text('message_id').references(() => messages.id),
    annotationId: text('annotation_id').references(() => annotations.id),
    title: text('title').notNull(),
    details: text('details'),
    status: text('status', { enum: ['open', 'done'] }).notNull().default('open'),
    /** Fractional index: ordinamento manuale della coda. */
    rank: text('rank').notNull(),
    priority: integer('priority'),
    /** Scadenza facoltativa, data ISO "AAAA-MM-GG". */
    dueDate: text('due_date'),
    completedAt: integer('completed_at'),
    ...meta(),
  },
  (t) => [index('tasks_status_rank').on(t.status, t.rank), index('tasks_project').on(t.projectId)],
);

// ─── Analizzatore, code, impostazioni ────────────────────────────────────────

export const suggestions = sqliteTable(
  'suggestions',
  {
    id: text('id').primaryKey(),
    kind: text('kind', {
      enum: ['project', 'new_project', 'conversation', 'contact', 'group', 'task', 'action', 'noise'],
    }).notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    /** JSON specifico per kind. */
    payload: text('payload').notNull(),
    confidence: real('confidence'),
    status: text('status', { enum: ['pending', 'accepted', 'rejected', 'auto_applied'] })
      .notNull()
      .default('pending'),
    model: text('model'),
    createdAt: integer('created_at').notNull(),
    resolvedAt: integer('resolved_at'),
  },
  (t) => [index('suggestions_subject').on(t.subjectType, t.subjectId), index('suggestions_status').on(t.status)],
);

/** Coda attività visibile all'utente: operazioni con effetti esterni, annullabili. */
export const activities = sqliteTable(
  'activities',
  {
    id: text('id').primaryKey(),
    // auto_sort: smistamento automatico (solo locale, nasce già eseguito: è una voce di cronologia).
    kind: text('kind', { enum: ['send', 'trash', 'archive', 'set_flags', 'auto_sort', 'spam'] }).notNull(),
    accountId: text('account_id').references(() => accounts.id),
    payload: text('payload').notNull(),
    status: text('status', { enum: ['pending', 'running', 'done', 'failed', 'cancelled'] })
      .notNull()
      .default('pending'),
    urgent: integer('urgent', { mode: 'boolean' }).notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    executedAt: integer('executed_at'),
  },
  (t) => [index('activities_status').on(t.status, t.createdAt)],
);

/**
 * Registro dello smistamento automatico (RF-E6): cosa avrebbe deciso (o ha deciso) la regola e cosa ha
 * fatto poi l'utente. Da qui la precisione misurata e i blocchi mittente → progetto.
 */
export const autoSortLog = sqliteTable(
  'auto_sort_log',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    projectId: text('project_id').notNull(),
    /** Mittente della conversazione (indirizzo), per bloccare la coppia mittente → progetto dopo un rifiuto. */
    sender: text('sender'),
    /** shadow = solo osservazione; auto = spostata davvero. */
    mode: text('mode', { enum: ['shadow', 'auto'] }).notNull(),
    /** Come ha deciso l'utente rispetto alla regola; null = non ancora. */
    outcome: text('outcome', { enum: ['agree', 'disagree'] }),
    createdAt: integer('created_at').notNull(),
    resolvedAt: integer('resolved_at'),
  },
  (t) => [index('auto_sort_conv').on(t.conversationId), index('auto_sort_sender').on(t.sender, t.projectId)],
);

/**
 * Regole per mittente create dalle azioni "è / non è una News", "è / non è Spam": valgono per la posta
 * futura. pattern = indirizzo esatto ("x@y.it") oppure dominio ("@y.it", vale anche per i sottodomini).
 */
export const senderRules = sqliteTable('sender_rules', {
  id: text('id').primaryKey(),
  pattern: text('pattern').notNull().unique(),
  kind: text('kind', { enum: ['news', 'not_news', 'spam', 'not_spam'] }).notNull(),
  createdAt: integer('created_at').notNull(),
});

/** Coda interna di lavori in background (parsing, analisi, embedding, backfill). */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    payload: text('payload').notNull(),
    priority: integer('priority').notNull().default(0),
    status: text('status', { enum: ['pending', 'running', 'done', 'failed'] }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    runAfter: integer('run_after').notNull(),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('jobs_pick').on(t.status, t.priority, t.runAfter),
    // Controllo dei doppioni a ogni accodamento: senza indice, con decine di migliaia di lavori, blocca il server.
    index('jobs_dedupe').on(t.kind, t.status, t.payload),
    // Scelta del prossimo lavoro (priorità, poi ordine di arrivo).
    index('jobs_order').on(t.status, t.priority, t.createdAt),
  ],
);

/** Chunk di testo pulito per gli embedding; i vettori stanno nella tabella virtuale chunk_vec. */
export const chunks = sqliteTable(
  'chunks',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').notNull().references(() => messages.id),
    ord: integer('ord').notNull(),
    text: text('text').notNull(),
    model: text('model').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('chunks_message').on(t.messageId)],
);

/** Bozze (S3): salvate in automatico, riappaiono come ultimo elemento del carosello. */
export const drafts = sqliteTable(
  'drafts',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id),
    /** NULL = nuova mail (nessuna conversazione ancora). */
    conversationId: text('conversation_id').references(() => conversations.id),
    replyToMessageId: text('reply_to_message_id').references(() => messages.id),
    forwardMessageId: text('forward_message_id').references(() => messages.id),
    /** JSON: string[]. */
    to: text('to').notNull().default('[]'),
    cc: text('cc').notNull().default('[]'),
    bcc: text('bcc').notNull().default('[]'),
    subject: text('subject').notNull().default(''),
    body: text('body').notNull().default(''),
    format: text('format', { enum: ['text', 'html'] }).notNull().default('text'),
    bodyHtml: text('body_html'),
    includeQuote: integer('include_quote', { mode: 'boolean' }).notNull().default(false),
    /** JSON: { id, blobSha, filename, mime, size }[]. */
    attachments: text('attachments').notNull().default('[]'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('drafts_conversation').on(t.conversationId)],
);

/** Chat con l'assistente (D12): una per conversazione, o per bozza di nuova mail. */
export const assistantMessages = sqliteTable(
  'assistant_messages',
  {
    id: text('id').primaryKey(),
    /** conversationId, oppure "draft:<id>" per una nuova mail. */
    thread: text('thread').notNull(),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    /** read = risposta su una conversazione; compose = testo proposto per la bozza. */
    mode: text('mode', { enum: ['read', 'compose'] }).notNull(),
    content: text('content').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('assistant_messages_thread').on(t.thread, t.createdAt)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  /** JSON. */
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
});
