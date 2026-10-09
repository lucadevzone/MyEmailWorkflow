import type { MessageDto } from '@mmw/shared';

export interface ComposeRequest {
  /** Conversazione del messaggio a cui si risponde (o da inoltrare). */
  conversationId?: string | null;
  replyTo?: MessageDto;
  replyAll?: boolean;
  forward?: MessageDto;
  to?: string[];
  projectId: string | null;
  /** Bozza proposta dall'analizzatore, messa sopra la citazione. */
  draft?: string;
}

/** Contenuto della colonna di destra. */
export type PaneState =
  | { kind: 'empty' }
  | { kind: 'message'; conversationId: string; messageId: string }
  | { kind: 'compose'; request: ComposeRequest; key: number }
  | { kind: 'note'; conversationId: string; noteId: string | null; key: number }
  | { kind: 'tasks'; projectId: string; draft?: TaskDraft; key?: number };

/** Nuovo task da compilare nel pannello, già collegato a conversazione e messaggio. */
export interface TaskDraft {
  title: string;
  conversationId: string;
  messageId: string;
}

export interface PaneAction {
  openMessage: (conversationId: string, messageId: string) => void;
  compose: (request: ComposeRequest) => void;
  openNote: (conversationId: string, noteId: string | null) => void;
  openTasks: (projectId: string, draft?: TaskDraft) => void;
  close: () => void;
}
