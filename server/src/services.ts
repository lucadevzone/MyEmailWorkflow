// Composizione dei servizi applicativi (usata dal server e dai test).
import type Database from 'better-sqlite3';
import type { AccountDto } from '@mmw/shared';
import type { Db } from './db/client.ts';
import { BlobStore } from './store/blobs.ts';
import { applyLlmModel, SettingsService } from './settings/service.ts';
import { AccountService } from './accounts/service.ts';
import { SyncManager } from './sync/manager.ts';
import { ActivityService } from './activities/service.ts';
import { ActivityRunner } from './activities/runner.ts';
import { MailActions } from './actions/mail-actions.ts';
import { createProvider } from './mail/factory.ts';
import { sendViaSmtp, type SmtpSender } from './mail/smtp.ts';
import type { MailProviderClient } from './mail/provider.ts';
import { PeopleService } from './people/service.ts';
import { NotesService } from './notes/service.ts';
import { JobRunner } from './jobs/runner.ts';
import { ollamaSummarizer, summarizeConversation, type Summarizer } from './ai/summarize.ts';
import { embedMessage, ollamaEmbedder, type Embedder } from './ai/embed.ts';
import { classifyConversation, type Llm } from './ai/classify.ts';
import { ollamaJson } from './ai/ollama-chat.ts';
import { SuggestionService } from './suggestions/service.ts';
import { TaskService } from './tasks/service.ts';
import { extractTasks } from './ai/extract-tasks.ts';
import { suggestActions } from './ai/suggest-actions.ts';
import { DraftService } from './drafts/service.ts';
import { SearchService } from './search/service.ts';
import { AssistantService, ollamaStream, type ChatStream } from './ai/assistant.ts';

export interface ServiceOverrides {
  createProvider?: (account: AccountDto) => MailProviderClient;
  sendSmtp?: SmtpSender;
  summarizer?: Summarizer;
  embedder?: Embedder;
  llm?: Llm;
  chatStream?: ChatStream;
}

export function buildServices(db: Db, sqlite: Database.Database, blobDir: string, o: ServiceOverrides = {}) {
  const blobs = new BlobStore(db, blobDir);
  const settings = new SettingsService(db);
  applyLlmModel(settings.get());
  const accounts = new AccountService(db);
  const providerFactory = o.createProvider ?? createProvider;
  const sync = new SyncManager({ db, sqlite, blobs }, () => settings.get().initialSyncDays, providerFactory);
  const activities = new ActivityService(db, sqlite);
  const runner = new ActivityRunner({
    db,
    blobs,
    activities,
    getAccount: (id) => accounts.get(id),
    createProvider: providerFactory,
    sendSmtp: o.sendSmtp ?? sendViaSmtp,
    batchMinutes: () => settings.get().activityBatchMinutes,
  });
  const actions = new MailActions({ db, sqlite, activities, runner, getAccount: (id) => accounts.get(id) });
  const people = new PeopleService(db, sqlite, blobs);
  const notes = new NotesService(db, blobs);
  const jobs = new JobRunner(db);
  const summarizer = o.summarizer ?? ollamaSummarizer;
  jobs.register('summarize', (p) => summarizeConversation(db, (p as { conversationId: string }).conversationId, summarizer));
  const embedder = o.embedder ?? ollamaEmbedder;
  jobs.register('embed', (p) => embedMessage(db, sqlite, (p as { messageId: string }).messageId, embedder));
  const llm: Llm = o.llm ?? ollamaJson;
  jobs.register('classify', (p) => classifyConversation({ db, sqlite, people, llm }, (p as { conversationId: string }).conversationId));
  jobs.register('extract_tasks', (p) => extractTasks(db, (p as { messageId: string }).messageId, llm));
  jobs.register('suggest_actions', (p) => suggestActions(db, (p as { messageId: string }).messageId, llm, (sha) => blobs.read(sha)));
  const tasks = new TaskService(db);
  const suggestions = new SuggestionService(db, actions, tasks);
  const assistant = new AssistantService({ db, stream: o.chatStream ?? ollamaStream, llm, readBlob: (sha) => blobs.read(sha) });
  const drafts = new DraftService({ db, blobs, actions, assistant });
  const search = new SearchService({ sqlite, embedder });
  return { db, sqlite, blobs, settings, accounts, sync, activities, runner, actions, people, notes, jobs, suggestions, tasks, drafts, assistant, search };
}
