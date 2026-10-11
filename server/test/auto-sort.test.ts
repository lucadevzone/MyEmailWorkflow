import { describe, expect, it } from 'vitest';
import { contentVote, decide, peopleVote, ruleReliable, type Vote } from '../src/ai/auto-sort.ts';

const v = (kind: Vote['kind'], projectId: string): Vote => ({ kind, projectId, reason: `${kind}→${projectId}` });
const ctx = { projectSize: () => 10, blocked: () => false, knownSender: true };

describe('regola dello smistamento automatico', () => {
  it('Persone: almeno 3 conversazioni e almeno l\'80% in un progetto', () => {
    expect(peopleVote([{ projectId: 'A', name: 'A', conversations: 4 }, { projectId: 'B', name: 'B', conversations: 1 }], 'Mario')).toMatchObject({
      projectId: 'A',
      reason: 'Mario: 4 conversazioni su 5 in A',
    });
    expect(peopleVote([{ projectId: 'A', name: 'A', conversations: 2 }], 'Mario')).toBeNull(); // poca storia
    expect(peopleVote([{ projectId: 'A', name: 'A', conversations: 3 }, { projectId: 'B', name: 'B', conversations: 2 }], 'Mario')).toBeNull(); // divisa
  });

  it('Contenuto: almeno 3 delle 4 smistate più simili nello stesso progetto', () => {
    const n = (p: string | null, s = 0.8) => ({ projectId: p, similarity: s });
    expect(contentVote([n('A'), n(null), n('A'), n('B'), n('A')], (id) => id)).toMatchObject({ projectId: 'A', reason: 'simile a 3 conversazioni di A' });
    expect(contentVote([n('A'), n('B'), n('A'), n('B')], (id) => id)).toBeNull();
    expect(contentVote([n('A', 0.3), n('A', 0.3), n('A', 0.3)], (id) => id)).toBeNull(); // troppo diverse
  });

  it('due segnali su tre, nessun dissenso, storia, nessun rifiuto', () => {
    expect(decide([v('people', 'A'), v('llm', 'A')], ctx)).toMatchObject({ projectId: 'A', ruleOk: true });
    expect(decide([v('llm', 'A')], ctx)).toMatchObject({ projectId: 'A', ruleOk: false, why: 'un solo segnale' });
    expect(decide([v('people', 'A'), v('content', 'A'), v('llm', 'B')], ctx)).toMatchObject({ projectId: 'A', ruleOk: false, why: 'i segnali indicano progetti diversi' });
    expect(decide([v('people', 'A'), v('llm', 'A')], { ...ctx, projectSize: () => 3 })).toMatchObject({ ruleOk: false, why: 'progetto con poche conversazioni' });
    expect(decide([v('people', 'A'), v('llm', 'A')], { ...ctx, blocked: () => true })).toMatchObject({ ruleOk: false, why: 'già rifiutato per questo mittente' });
    expect(decide([v('content', 'A'), v('llm', 'A')], { ...ctx, knownSender: false })).toMatchObject({ ruleOk: false, why: 'mittente senza storia' });
    // A pari voti si suggerisce il progetto dell'LLM.
    expect(decide([v('people', 'A'), v('llm', 'B')], ctx).projectId).toBe('B');
  });

  it('affidabile solo con almeno il 90% su almeno 10 casi', () => {
    expect(ruleReliable({ agree: 9, total: 9 })).toBe(false);
    expect(ruleReliable({ agree: 9, total: 10 })).toBe(true);
    expect(ruleReliable({ agree: 17, total: 20 })).toBe(false);
  });
});
