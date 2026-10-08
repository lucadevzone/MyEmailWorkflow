import type { MessageDto } from '@mmw/shared';

export interface ComposeRequest {
  replyTo?: MessageDto;
  replyAll?: boolean;
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
  | { kind: 'tasks'; projectId: string };

export interface PaneAction {
  openMessage: (conversationId: string, messageId: string) => void;
  compose: (request: ComposeRequest) => void;
  openNote: (conversationId: string, noteId: string | null) => void;
  openTasks: (projectId: string) => void;
  close: () => void;
}
