// Fonti per una domanda su tutta la posta, quando la ricerca non ne ha già scelte: ricerca larga
// (parole in OR + significato), prime 6 conversazioni col messaggio più pertinente.

import type { SearchService } from '../search/service.ts';

export interface AskSourceInfo {
  conversationId: string;
  messageId: string | null;
  projectId: string | null;
  isNoise: boolean;
  title: string;
}

export const MAX_ASK_SOURCES = 6;

export async function findAskSources(search: SearchService, question: string): Promise<AskSourceInfo[]> {
  const res = await search.search(question, 'all', { loose: true });
  return res.conversations.slice(0, MAX_ASK_SOURCES).map((c) => ({
    conversationId: c.conversationId,
    messageId: c.messageId,
    projectId: c.projectId,
    isNoise: c.isNoise,
    title: c.title,
  }));
}
