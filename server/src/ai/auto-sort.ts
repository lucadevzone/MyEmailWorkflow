// Smistamento automatico con fiducia misurata (RF-E6, docs/02-system-design.md §6.2.1).
// Tre segnali sì/no con un motivo leggibile; la regola sposta da sola solo se due concordano, nessuno
// dissente, il progetto ha una storia e l'utente non l'ha mai rifiutato per quel mittente.

export type SignalKind = 'people' | 'content' | 'llm';

export interface Vote {
  kind: SignalKind;
  projectId: string;
  reason: string;
}

/** Soglie della regola (dal documento di progetto). */
export const RULE = {
  /** Persone: conversazioni già smistate dei partecipanti, e quota minima in un solo progetto. */
  peopleMinConversations: 3,
  peopleMinShare: 0.8,
  /** Contenuto: tra le 4 conversazioni smistate più simili, quante nello stesso progetto. */
  contentNeighbors: 4,
  contentMinSame: 3,
  contentMinSimilarity: 0.5,
  /** Il progetto deve avere almeno tante conversazioni. */
  projectMinConversations: 5,
  /** Osservazione: lo spostamento automatico si attiva con questa precisione su almeno tanti casi. */
  minPrecision: 0.9,
  minCases: 10,
} as const;

export interface PeopleCount {
  projectId: string;
  name: string;
  conversations: number;
}

/** Segnale Persone: i partecipanti stanno quasi solo in un progetto. */
export function peopleVote(counts: PeopleCount[], who: string): Vote | null {
  const total = counts.reduce((n, c) => n + c.conversations, 0);
  const top = [...counts].sort((a, b) => b.conversations - a.conversations)[0];
  if (!top || total < RULE.peopleMinConversations || top.conversations / total < RULE.peopleMinShare) return null;
  return { kind: 'people', projectId: top.projectId, reason: `${who}: ${top.conversations} conversazioni su ${total} in ${top.name}` };
}

/** Segnale Contenuto: le conversazioni smistate più simili stanno quasi tutte in un progetto. */
export function contentVote(neighbors: { projectId: string | null; similarity: number }[], nameOf: (id: string) => string): Vote | null {
  const near = neighbors.filter((n) => n.projectId && n.similarity >= RULE.contentMinSimilarity).slice(0, RULE.contentNeighbors);
  const by = new Map<string, number>();
  for (const n of near) by.set(n.projectId!, (by.get(n.projectId!) ?? 0) + 1);
  const best = [...by.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < RULE.contentMinSame) return null;
  return { kind: 'content', projectId: best[0], reason: `simile a ${best[1]} conversazioni di ${nameOf(best[0])}` };
}

export interface Decision {
  /** Progetto da suggerire (il più votato; a pari voti quello dell'LLM). */
  projectId: string | null;
  votes: Vote[];
  /** La regola dello spostamento automatico è soddisfatta. */
  ruleOk: boolean;
  /** Perché la regola non si applica (per capire e per i test). */
  why: string | null;
}

export function decide(
  votes: Vote[],
  ctx: { projectSize: (id: string) => number; blocked: (id: string) => boolean; knownSender: boolean },
): Decision {
  if (!votes.length) return { projectId: null, votes: [], ruleOk: false, why: 'nessun segnale' };
  const count = new Map<string, number>();
  for (const v of votes) count.set(v.projectId, (count.get(v.projectId) ?? 0) + 1);
  const llm = votes.find((v) => v.kind === 'llm')?.projectId;
  const [projectId, n] = [...count.entries()].sort((a, b) => b[1] - a[1] || Number(b[0] === llm) - Number(a[0] === llm))[0]!;
  const mine = votes.filter((v) => v.projectId === projectId);
  const why =
    n < 2
      ? 'un solo segnale'
      : votes.some((v) => v.projectId !== projectId)
        ? 'i segnali indicano progetti diversi'
        : !ctx.knownSender
          ? 'mittente senza storia'
          : ctx.projectSize(projectId) < RULE.projectMinConversations
            ? 'progetto con poche conversazioni'
            : ctx.blocked(projectId)
              ? 'già rifiutato per questo mittente'
              : null;
  return { projectId, votes: mine, ruleOk: why === null, why };
}

/** Precisione misurata in osservazione: la regola si attiva solo se ha deciso come l'utente abbastanza volte. */
export function ruleReliable(stats: { agree: number; total: number }): boolean {
  return stats.total >= RULE.minCases && stats.agree / stats.total >= RULE.minPrecision;
}
