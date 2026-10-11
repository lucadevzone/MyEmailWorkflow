// Registro dello smistamento automatico (RF-E6): la regola annota cosa avrebbe deciso, poi l'esito si
// ricava da ciò che fa l'utente. Da qui la precisione misurata (che accende o spegne l'automatico)
// e i blocchi mittente → progetto dopo un rifiuto.

import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { autoSortLog } from '../db/schema.ts';
import { newId, now } from '../lib/ids.ts';
import { ruleReliable } from './auto-sort.ts';

/** Quanti esiti recenti contano per la precisione (le abitudini cambiano). */
const WINDOW = 50;

/** La regola ha deciso per questa conversazione: una sola decisione aperta per conversazione. */
export function recordDecision(db: Db, e: { conversationId: string; projectId: string; sender: string | null; mode: 'shadow' | 'auto' }) {
  const open = db
    .select({ id: autoSortLog.id })
    .from(autoSortLog)
    .where(and(eq(autoSortLog.conversationId, e.conversationId), isNull(autoSortLog.outcome)))
    .get();
  if (open) {
    db.update(autoSortLog).set({ projectId: e.projectId, sender: e.sender, mode: e.mode }).where(eq(autoSortLog.id, open.id)).run();
    return;
  }
  db.insert(autoSortLog).values({ id: newId(), ...e, createdAt: now() }).run();
}

/**
 * L'utente ha messo la conversazione in un progetto (o in Da smistare): l'ultima decisione della regola
 * per quella conversazione è giusta se coincide. Lo spostamento fatto a mano è il segnale definitivo:
 * corregge anche un esito già dato (es. "aperta e tenuta", poi spostata altrove).
 */
export function resolveByMove(db: Db, conversationId: string, projectId: string | null) {
  const last = db
    .select()
    .from(autoSortLog)
    .where(eq(autoSortLog.conversationId, conversationId))
    .orderBy(desc(autoSortLog.createdAt))
    .get();
  if (!last) return;
  db.update(autoSortLog)
    .set({ outcome: last.projectId === projectId ? 'agree' : 'disagree', resolvedAt: now() })
    .where(eq(autoSortLog.id, last.id))
    .run();
}

/** Suggerimento di quel progetto scartato: la regola aveva torto (se aveva deciso quello). */
export function resolveByReject(db: Db, conversationId: string, projectId: string) {
  db.update(autoSortLog)
    .set({ outcome: 'disagree', resolvedAt: now() })
    .where(and(eq(autoSortLog.conversationId, conversationId), eq(autoSortLog.projectId, projectId), isNull(autoSortLog.outcome)))
    .run();
}

/** Conversazione smistata da sola, aperta e lasciata lì: la regola aveva ragione. */
export function resolveByKeep(db: Db, conversationId: string) {
  db.update(autoSortLog)
    .set({ outcome: 'agree', resolvedAt: now() })
    .where(and(eq(autoSortLog.conversationId, conversationId), eq(autoSortLog.mode, 'auto'), isNull(autoSortLog.outcome)))
    .run();
}

/** Quel progetto è stato rifiutato (o corretto) per quel mittente: niente più spostamenti automatici. */
export function isBlocked(db: Db, sender: string | null, projectId: string): boolean {
  if (!sender) return false;
  return !!db
    .select({ id: autoSortLog.id })
    .from(autoSortLog)
    .where(and(eq(autoSortLog.sender, sender), eq(autoSortLog.projectId, projectId), eq(autoSortLog.outcome, 'disagree')))
    .get();
}

export interface AutoSortStats {
  /** Esiti recenti: decisioni della regola confermate dall'utente, sul totale. */
  agree: number;
  total: number;
  /** Decisioni in attesa di un tuo gesto. */
  pending: number;
  /** Spostamenti fatti davvero (non solo in osservazione). */
  autoMoves: number;
  /** La regola si è dimostrata affidabile: l'automatico può agire. */
  reliable: boolean;
}

export function autoSortStats(db: Db): AutoSortStats {
  const resolved = db
    .select({ outcome: autoSortLog.outcome })
    .from(autoSortLog)
    .where(isNotNull(autoSortLog.outcome))
    .orderBy(desc(autoSortLog.resolvedAt))
    .limit(WINDOW)
    .all();
  const agree = resolved.filter((r) => r.outcome === 'agree').length;
  const pending = db.select({ id: autoSortLog.id }).from(autoSortLog).where(isNull(autoSortLog.outcome)).all().length;
  const autoMoves = db.select({ id: autoSortLog.id }).from(autoSortLog).where(eq(autoSortLog.mode, 'auto')).all().length;
  return { agree, total: resolved.length, pending, autoMoves, reliable: ruleReliable({ agree, total: resolved.length }) };
}
