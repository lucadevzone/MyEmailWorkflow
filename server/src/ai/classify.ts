// Progetto suggerito per le conversazioni in Da smistare. Vedi docs/02-system-design.md §6.2.
// Tre segnali: persone (dove compaiono i partecipanti), somiglianza (vicini già smistati),
// LLM (sceglie tra i candidati leggendo nome e descrizione dei progetti).
// Il risultato è un suggerimento in attesa: non si applica mai da solo.

import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import type { Db } from '../db/client.ts';
import { accounts, conversations, messages, projects, suggestions } from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';
import { bus } from '../events/bus.ts';
import { config } from '../config.ts';
import { enqueueJob, PRIORITY } from '../jobs/queue.ts';
import type { PeopleService } from '../people/service.ts';
import { similarConversations } from './embed.ts';
import { contentVote, decide, peopleVote, type SignalKind, type Vote } from './auto-sort.ts';

export type Llm = <T>(system: string, user: string) => Promise<T>;

/** Sotto questa confidenza il suggerimento non viene mostrato. */
export const MIN_CONFIDENCE = 0.4;
const MAX_CANDIDATES = 6;

const SYSTEM =
  'Sei un assistente che smista la posta di un utente nei suoi progetti. ' +
  'Scegli il progetto più adatto solo se è davvero pertinente; altrimenti rispondi "nessuno". ' +
  'Scrivi in italiano. Rispondi solo con un oggetto JSON.';

interface LlmAnswer {
  scelta?: string;
  confidenza?: number;
  motivo?: string;
  nome_nuovo?: string;
}

export interface ProjectSuggestionPayload {
  projectId: string | null;
  projectName: string;
  /** Motivi leggibili, uniti: "Luca: 5 conversazioni su 5 in X · simile a 3 conversazioni di X · …". */
  reason: string;
  signals: { people: number; similarity: number };
  /** Segnali che indicano questo progetto (RF-E6). */
  votes?: SignalKind[];
  /** La regola dello spostamento automatico è soddisfatta; altrimenti il perché. */
  ruleOk?: boolean;
  ruleWhy?: string | null;
}

export function enqueueClassification(db: Db, conversationId: string, priority: number = PRIORITY.normal) {
  db.update(conversations).set({ classifiedAt: null }).where(eq(conversations.id, conversationId)).run();
  enqueueJob(db, 'classify', { conversationId }, priority);
}

/** Da smistare (non rumore) ancora da classificare. */
export function enqueueMissingClassifications(db: Db) {
  const rows = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        isNull(conversations.deletedAt),
        isNull(conversations.trashedAt),
        isNull(conversations.projectId),
        isNull(conversations.classifiedAt),
        eq(conversations.isNoise, false),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))
    .all();
  for (const r of rows) enqueueJob(db, 'classify', { conversationId: r.id }, PRIORITY.background);
}

/** Dopo la creazione o la modifica di un progetto: tutta Da smistare va rivalutata. */
export function reclassifyInbox(db: Db) {
  db.update(conversations)
    .set({ classifiedAt: null })
    .where(and(isNull(conversations.projectId), isNull(conversations.deletedAt), eq(conversations.isNoise, false)))
    .run();
  enqueueMissingClassifications(db);
}

export function clearProjectSuggestions(db: Db, conversationId: string) {
  db.delete(suggestions)
    .where(
      and(
        eq(suggestions.subjectType, 'conversation'),
        eq(suggestions.subjectId, conversationId),
        inArray(suggestions.kind, ['project', 'new_project']),
        eq(suggestions.status, 'pending'),
      ),
    )
    .run();
}

export async function classifyConversation(deps: { db: Db; sqlite: Database.Database; people: PeopleService; llm: Llm }, conversationId: string) {
  const { db, sqlite } = deps;
  const conv = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  const done = () => db.update(conversations).set({ classifiedAt: now() }).where(eq(conversations.id, conversationId)).run();
  if (!conv || conv.deletedAt || conv.trashedAt || conv.projectId || conv.isNoise) {
    clearProjectSuggestions(db, conversationId);
    if (conv) done();
    return;
  }

  // Progetti rifiutati dall'utente per questa conversazione: non si ripropongono.
  const rejected = new Set(
    db
      .select({ payload: suggestions.payload })
      .from(suggestions)
      .where(and(eq(suggestions.subjectId, conversationId), eq(suggestions.kind, 'project'), eq(suggestions.status, 'rejected')))
      .all()
      .map((r) => (JSON.parse(r.payload) as ProjectSuggestionPayload).projectId),
  );
  const active = db
    .select()
    .from(projects)
    .where(and(isNull(projects.deletedAt), eq(projects.archived, false)))
    .orderBy(asc(projects.name))
    .all()
    .filter((p) => !rejected.has(p.id));
  if (!active.length) {
    clearProjectSuggestions(db, conversationId);
    done();
    return;
  }

  // ── Segnali ────────────────────────────────────────────────────────────────
  const msgs = db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), isNull(messages.deletedAt)))
    .orderBy(asc(messages.date))
    .all();
  const own = new Set(db.select({ e: accounts.email }).from(accounts).all().map((a) => a.e.toLowerCase()));
  const participants = new Map<string, string | null>();
  for (const m of msgs) if (m.fromAddress && !own.has(m.fromAddress)) participants.set(m.fromAddress, m.fromName);
  const recipients = sqlite
    .prepare(
      `select distinct ca.email as email, ca.display_name as name from message_addresses ma
         join messages m on m.id = ma.message_id join contact_addresses ca on ca.id = ma.contact_address_id
        where m.conversation_id = ? and m.deleted_at is null`,
    )
    .all(conversationId) as { email: string; name: string | null }[];
  for (const r of recipients) if (!own.has(r.email) && !participants.has(r.email)) participants.set(r.email, r.name);

  const byPeople = new Map(deps.people.suggestProjects([...participants.keys()]).map((s) => [s.projectId, s.conversations]));
  const maxPeople = Math.max(1, ...byPeople.values());
  const simLists = new Map<string, number[]>();
  for (const n of similarConversations(sqlite, conversationId)) {
    if (!n.projectId) continue;
    simLists.set(n.projectId, [...(simLists.get(n.projectId) ?? []), n.similarity]);
  }
  const scored = active.map((p) => {
    const sims = (simLists.get(p.id) ?? []).slice(0, 3);
    const similarity = sims.length ? sims.reduce((a, b) => a + Math.max(0, b), 0) / 3 : 0;
    const people = (byPeople.get(p.id) ?? 0) / maxPeople;
    return { p, people, similarity, signal: 0.6 * similarity + 0.4 * people };
  });
  scored.sort((a, b) => b.signal - a.signal);
  const candidates = scored.slice(0, MAX_CANDIDATES);

  // ── LLM ────────────────────────────────────────────────────────────────────
  const examples = (projectId: string) =>
    db
      .select({ s: conversations.subject })
      .from(conversations)
      .where(and(eq(conversations.projectId, projectId), isNull(conversations.deletedAt)))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(3)
      .all()
      .map((r) => r.s)
      .filter(Boolean);
  const level = (x: number) => (x > 0.66 ? 'alta' : x > 0.33 ? 'media' : x > 0 ? 'bassa' : 'nessuna');
  const last = msgs.slice(-2).map((m) => {
    const who = m.direction === 'out' ? 'Io' : m.fromName || m.fromAddress || 'Sconosciuto';
    return `${who}: ${(m.bodyTextClean || m.bodyText || '').slice(0, 1200)}`;
  });
  const prompt = [
    `Conversazione da smistare`,
    `Oggetto: ${conv.subject ?? '(nessuno)'}`,
    conv.summary ? `Sintesi: ${conv.summaryDetailed ?? conv.summary}` : '',
    `Persone coinvolte: ${[...participants].map(([e, n]) => (n ? `${n} <${e}>` : e)).join(', ') || 'solo io'}`,
    '',
    'Ultimi messaggi:',
    last.join('\n---\n'),
    '',
    'Progetti candidati:',
    ...candidates.map((c, i) =>
      [
        `P${i + 1}: ${c.p.name}`,
        c.p.description ? `   descrizione: ${c.p.description}` : '',
        examples(c.p.id).length ? `   conversazioni recenti: ${examples(c.p.id).join(' | ')}` : '',
        `   indizi: persone in comune ${level(c.people)}, somiglianza con le sue email ${level(c.similarity)}`,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    '',
    'Rispondi con un JSON:',
    '- "scelta": l\'etichetta del progetto (es. "P1"), oppure "nessuno" se nessuno è pertinente, oppure "nuovo" se servirebbe un progetto nuovo;',
    '- "confidenza": numero tra 0 e 1;',
    '- "motivo": una frase breve che spieghi la scelta all\'utente;',
    '- "nome_nuovo": solo se "nuovo", un nome breve per il progetto.',
  ]
    .filter((l) => l !== '')
    .join('\n');

  const answer = await deps.llm<LlmAnswer>(SYSTEM, prompt);
  const llmConf = Math.min(1, Math.max(0, Number(answer.confidenza) || 0));
  const choice = (answer.scelta ?? '').trim().toUpperCase();
  const idx = /^P(\d+)$/.exec(choice)?.[1];
  const picked = idx ? candidates[Number(idx) - 1] : undefined;

  // ── Segnali sì/no e regola (RF-E6) ───────────────────────────────────────
  const nameOf = (id: string) => active.find((p) => p.id === id)?.name ?? 'progetto';
  const peopleCounts = deps.people.suggestProjects([...participants.keys()], 50).filter((c) => !rejected.has(c.projectId));
  const named = [...participants.values()].filter(Boolean);
  const who = participants.size === 1 ? (named[0] ?? [...participants.keys()][0]!) : 'le persone coinvolte';
  const votes: Vote[] = [];
  const pv = peopleVote(peopleCounts, who);
  if (pv) votes.push(pv);
  const cv = contentVote(similarConversations(sqlite, conversationId).filter((n) => !n.projectId || !rejected.has(n.projectId)), nameOf);
  if (cv) votes.push(cv);
  // L'LLM vota solo se è abbastanza convinto: sotto la soglia la sua scelta non conta.
  if (picked && llmConf >= 0.5) votes.push({ kind: 'llm', projectId: picked.p.id, reason: answer.motivo?.trim() || `l'analizzatore sceglie ${picked.p.name}` });
  const size = new Map(
    (sqlite.prepare('select project_id as id, count(*) as n from conversations where project_id is not null and deleted_at is null group by project_id').all() as { id: string; n: number }[]).map(
      (r) => [r.id, r.n],
    ),
  );
  const decision = decide(votes, {
    projectSize: (id) => size.get(id) ?? 0,
    blocked: (id) => rejected.has(id) || isBlocked(db, senderOf(msgs, own), id),
    knownSender: peopleCounts.length > 0,
  });

  clearProjectSuggestions(db, conversationId);
  if (decision.projectId) {
    const p = active.find((x) => x.id === decision.projectId)!;
    const s = scored.find((x) => x.p.id === p.id);
    saveSuggestion(db, conversationId, 'project', decision.votes.length / 3, {
      projectId: p.id,
      projectName: p.name,
      reason: decision.votes.map((v) => v.reason).join(' · '),
      signals: { people: round(s?.people ?? 0), similarity: round(s?.similarity ?? 0) },
      votes: decision.votes.map((v) => v.kind),
      ruleOk: decision.ruleOk,
      ruleWhy: decision.why,
    });
  } else if (choice === 'NUOVO' && answer.nome_nuovo?.trim() && llmConf >= 0.6) {
    saveSuggestion(db, conversationId, 'new_project', llmConf * 0.8, {
      projectId: null,
      projectName: answer.nome_nuovo.trim().slice(0, 60),
      reason: answer.motivo?.trim() || '',
      signals: { people: 0, similarity: 0 },
    });
  }
  done();
  bus.publish({ type: 'conversations', ids: [conversationId] });
}

/** Mittente della conversazione: chi ha scritto il primo messaggio arrivato (non i propri account). */
export function senderOf(msgs: { direction: string; fromAddress: string | null }[], own: Set<string>): string | null {
  return msgs.find((m) => m.direction === 'in' && m.fromAddress && !own.has(m.fromAddress))?.fromAddress?.toLowerCase() ?? null;
}

/** Quel progetto è stato rifiutato per quel mittente (vedi il registro dell'osservazione). */
function isBlocked(_db: Db, _sender: string | null, _projectId: string): boolean {
  return false;
}

function saveSuggestion(db: Db, conversationId: string, kind: 'project' | 'new_project', confidence: number, payload: ProjectSuggestionPayload) {
  db.insert(suggestions)
    .values({
      id: newId(),
      kind,
      subjectType: 'conversation',
      subjectId: conversationId,
      payload: JSON.stringify(payload),
      confidence: round(confidence),
      status: 'pending',
      model: config.ollama.llmModel,
      createdAt: now(),
    })
    .run();
}

const round = (x: number) => Math.round(x * 100) / 100;
