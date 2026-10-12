// URL dell'app (specifica §2.3). "inbox" e "news" sono i due progetti di sistema.
export const SYSTEM_INBOX = 'inbox';
export const SYSTEM_NEWS = 'news';
export const SYSTEM_SPAM = 'spam';

export const paths = {
  project: (projectId: string) => `/p/${projectId}`,
  conversation: (projectId: string, conversationId: string) => `/p/${projectId}/c/${conversationId}`,
  message: (projectId: string, conversationId: string, messageId: string) => `/p/${projectId}/c/${conversationId}/m/${messageId}`,
  draft: (projectId: string, conversationId: string, draftId: string) => `/p/${projectId}/c/${conversationId}/draft/${draftId}`,
  /** Nuova mail (bozza senza conversazione). */
  newMail: (projectId: string, draftId: string) => `/p/${projectId}/draft/${draftId}`,
  /** Impostazioni del progetto (pagina). */
  projectSettings: (projectId: string) => `/p/${projectId}/settings`,
  /** Nuovo progetto; i parametri precompilano il modulo (es. dal suggerimento dell'analizzatore). */
  newProject: (q: { name?: string; description?: string; suggestion?: string; conversation?: string } = {}) => {
    const p = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => !!e[1]));
    return `/projects/new${p.size ? `?${p}` : ''}`;
  },
  contacts: () => '/contacts',
  settings: () => '/settings',
};

/** Progetto (o vista di sistema) a cui appartiene una conversazione. */
export function projectKeyOf(c: { projectId: string | null; isNoise: boolean; isSpam?: boolean }): string {
  if (c.isSpam) return SYSTEM_SPAM;
  return c.projectId ?? (c.isNoise ? SYSTEM_NEWS : SYSTEM_INBOX);
}
