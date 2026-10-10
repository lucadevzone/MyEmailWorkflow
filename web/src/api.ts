import type {
  AccountDto,
  ActivityQueueDto,
  ComposeInput,
  ConversationDetail,
  ConversationListItem,
  ConversationQuery,
  ContactInput,
  NoteDto,
  PeopleDirectoryDto,
  PersonDto,
  ProjectDto,
  ProjectMembersDto,
  ProjectSuggestion,
  ResourceDto,
  DraftDto,
  DraftPatch,
  AssistantMessageDto,
  SearchResults,
  QuoteSelector,
  AnnotationMarkDto,
  SearchScope,
  ReplyIdea,
  TaskDto,
  TaskInput,
  UnreadCountsDto,
  ProjectInput,
  SyncStatusDto,
  ConnectionTestResult,
  CreateAccountInput,
  HealthDto,
  SettingsDto,
} from '@mmw/shared';

/** Carica un file come corpo grezzo (nome e tipo a parte). */
async function upload(url: string, file: File): Promise<ResourceDto> {
  const res = await fetch(`${url}?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'x-mmw': '1', 'content-type': 'application/octet-stream', 'x-file-type': file.type || '' },
    body: file,
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
  return (await res.json()) as ResourceDto;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['x-mmw'] = '1';
  // Content-Type solo con un corpo: Fastify rifiuta JSON dichiarato ma vuoto.
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** Fonte usata dall'assistente sulla posta (quando l'ha cercata da sé). */
export interface AskSource {
  conversationId: string;
  projectId: string | null;
  isNoise: boolean;
  title: string;
}

export interface AssistantScope {
  conversationId?: string | null;
  draftId?: string | null;
}

export type AssistantAction = 'summarize' | 'needs_reply' | 'extract_tasks' | 'translate' | 'formal' | 'shorter' | 'english' | 'fix' | 'rephrase';

export interface AssistantChatInput extends AssistantScope {
  mode: 'read' | 'compose';
  messageId?: string | null;
  draftBody?: string;
  action?: AssistantAction;
  text: string;
}

const scopeQuery = (q: AssistantScope) =>
  q.conversationId ? `conversationId=${encodeURIComponent(q.conversationId)}` : `draftId=${encodeURIComponent(q.draftId ?? '')}`;

export const api = {
  health: () => request<HealthDto>('GET', '/api/health'),
  accounts: () => request<AccountDto[]>('GET', '/api/accounts'),
  createAccount: (input: CreateAccountInput) => request<AccountDto>('POST', '/api/accounts', input),
  deleteAccount: (id: string) => request<void>('DELETE', `/api/accounts/${id}`),
  testAccount: (id: string) => request<ConnectionTestResult>('POST', `/api/accounts/${id}/test`),
  setAccountPassword: (id: string, password: string) => request<AccountDto>('PUT', `/api/accounts/${id}/password`, { password }),
  settings: () => request<SettingsDto>('GET', '/api/settings'),
  syncStatus: () => request<SyncStatusDto[]>('GET', '/api/sync/status'),
  syncNow: () => request<SyncStatusDto[]>('POST', '/api/sync/now'),
  conversations: (q: ConversationQuery) => {
    const p = new URLSearchParams({ view: q.view });
    if (q.projectId) p.set('projectId', q.projectId);
    if (q.person) p.set('person', q.person);
    if (q.archived) p.set('archived', '1');
    if (q.before) p.set('before', String(q.before));
    return request<ConversationListItem[]>('GET', `/api/conversations?${p}`);
  },
  conversationCounts: () => request<UnreadCountsDto>('GET', '/api/conversations/counts'),
  conversation: (id: string) => request<ConversationDetail>('GET', `/api/conversations/${id}`),
  setNoise: (id: string, isNoise: boolean) => request<{ ok: true }>('POST', `/api/conversations/${id}/noise`, { isNoise }),
  markMessageRead: (id: string) => request<{ activityIds: string[] }>('POST', `/api/messages/${id}/read`),
  markRead: (id: string) => request<{ activityIds: string[] }>('POST', `/api/conversations/${id}/read`),
  markUnread: (id: string) => request<{ activityIds: string[] }>('POST', `/api/conversations/${id}/unread`),
  archive: (id: string) => request<{ activityIds: string[] }>('POST', `/api/conversations/${id}/archive`),
  unarchive: (id: string) => request<{ ok: true }>('POST', `/api/conversations/${id}/unarchive`),
  trash: (id: string) => request<{ activityIds: string[] }>('POST', `/api/conversations/${id}/trash`),
  move: (id: string, projectId: string | null) =>
    request<{ previousProjectId: string | null }>('POST', `/api/conversations/${id}/move`, { projectId }),
  markViewRead: (view: 'inbox' | 'noise' | 'project', projectId?: string) =>
    request<{ count: number; activityIds: string[] }>('POST', '/api/views/read', { view, projectId }),
  attachmentToResource: (id: string) => request<ResourceDto>('POST', `/api/attachments/${id}/to-resource`),
  compose: (input: ComposeInput) =>
    request<{ activityId: string; conversationId: string; messageId: string }>('POST', '/api/compose', input),

  projects: () => request<ProjectDto[]>('GET', '/api/projects'),
  createProject: (input: ProjectInput) => request<ProjectDto>('POST', '/api/projects', input),
  updateProject: (id: string, patch: Partial<ProjectInput> & { archived?: boolean }) =>
    request<ProjectDto>('PATCH', `/api/projects/${id}`, patch),

  activities: () => request<ActivityQueueDto>('GET', '/api/activities'),
  cancelActivity: (id: string) => request<unknown>('POST', `/api/activities/${id}/cancel`),
  blockActivity: (id: string) => request<DraftDto>('POST', `/api/activities/${id}/block`),
  blockSend: (messageId: string) => request<DraftDto>('POST', `/api/messages/${messageId}/block-send`),
  detachMessage: (messageId: string, projectId?: string | null, withReplies = true) =>
    request<{ conversationId: string; fromConversationId: string; moved: number }>(
      'POST', `/api/messages/${messageId}/detach`, projectId === undefined ? { withReplies } : { projectId, withReplies },
    ),
  rejoinConversation: (conversationId: string) => request<{ conversationId: string }>('POST', `/api/conversations/${conversationId}/rejoin`),
  runActivity: (id: string) => request<unknown>('POST', `/api/activities/${id}/run`),
  retryActivity: (id: string) => request<unknown>('POST', `/api/activities/${id}/retry`),
  runAllActivities: () => request<unknown>('POST', '/api/activities/run'),
  updateSettings: (patch: Partial<SettingsDto>) => request<SettingsDto>('PUT', '/api/settings', patch),

  people: (scope: { view: 'inbox' | 'noise' | 'project' | 'all'; projectId?: string }) =>
    request<PersonDto[]>('GET', `/api/people?view=${scope.view}${scope.projectId ? `&projectId=${scope.projectId}` : ''}`),
  peopleDirectory: () => request<PeopleDirectoryDto>('GET', '/api/people/directory'),
  suggestProject: (emails: string[]) =>
    request<ProjectSuggestion[]>('GET', `/api/people/suggest-project?emails=${encodeURIComponent(emails.join(','))}`),
  createContact: (input: ContactInput) => request<PersonDto>('POST', '/api/contacts', input),
  updateContact: (id: string, input: Partial<ContactInput>) => request<PersonDto>('PATCH', `/api/contacts/${id}`, input),
  deleteContact: (id: string) => request<void>('DELETE', `/api/contacts/${id}`),
  setAvatar: async (contactId: string, image: Blob): Promise<PersonDto> => {
    const res = await fetch(`/api/contacts/${contactId}/avatar`, {
      method: 'PUT',
      headers: { 'x-mmw': '1', 'content-type': 'application/octet-stream' },
      body: image,
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
    return (await res.json()) as PersonDto;
  },
  mergeContact: (contactId: string, personKey: string) => request<PersonDto>('POST', `/api/contacts/${contactId}/merge`, { personKey }),
  removeAvatar: (contactId: string) => request<PersonDto>('DELETE', `/api/contacts/${contactId}/avatar`),
  addProjectContact: (projectId: string, input: { contactId?: string; name?: string; email?: string }) =>
    request<PersonDto>('POST', `/api/projects/${projectId}/contacts`, input),
  projectTasks: (projectId: string) => request<TaskDto[]>('GET', `/api/projects/${projectId}/tasks`),
  conversationTasks: (conversationId: string) => request<TaskDto[]>('GET', `/api/conversations/${conversationId}/tasks`),
  createTask: (input: TaskInput) => request<TaskDto>('POST', '/api/tasks', input),
  remindReply: (conversationId: string, messageId?: string) => request<TaskDto>('POST', `/api/conversations/${conversationId}/remind-reply`, { messageId }),
  updateTask: (id: string, patch: Partial<Pick<TaskDto, 'title' | 'details' | 'dueDate' | 'status'>>) => request<TaskDto>('PATCH', `/api/tasks/${id}`, patch),
  moveTask: (id: string, afterId: string | null) => request<TaskDto>('POST', `/api/tasks/${id}/move`, { afterId }),
  deleteTask: (id: string) => request<void>('DELETE', `/api/tasks/${id}`),
  acceptSuggestion: (id: string, projectId?: string) => request<{ conversationId: string }>('POST', `/api/suggestions/${id}/accept`, { projectId }),
  rejectSuggestion: (id: string) => request<{ conversationId: string }>('POST', `/api/suggestions/${id}/reject`),
  reorderProjects: (ids: string[]) => request<{ ok: true }>('PUT', '/api/projects/order', { ids }),
  removeProject: (id: string) => request<{ movedConversations: number }>('POST', `/api/projects/${id}/remove`),
  mergeProject: (id: string, intoId: string) => request<{ movedConversations: number }>('POST', `/api/projects/${id}/merge`, { intoId }),
  reorderProjectMembers: (projectId: string, keys: string[]) => request<{ ok: true }>('PUT', `/api/projects/${projectId}/members/order`, { keys }),
  projectMembers: (projectId: string) => request<ProjectMembersDto>('GET', `/api/projects/${projectId}/members`),
  addProjectGroup: (projectId: string, groupId: string) => request<ProjectMembersDto>('POST', `/api/projects/${projectId}/groups`, { groupId }),
  removeProjectGroup: (projectId: string, groupId: string) => request<void>('DELETE', `/api/projects/${projectId}/groups/${groupId}`),
  participantsToProject: (conversationId: string, groupName?: string) =>
    request<ProjectMembersDto>('POST', `/api/conversations/${conversationId}/participants-to-project`, { groupName }),
  removeProjectContact: (projectId: string, contactId: string) =>
    request<void>('DELETE', `/api/projects/${projectId}/contacts/${contactId}`),
  createGroup: (name: string, contactIds: string[]) => request<{ id: string }>('POST', '/api/groups', { name, contactIds }),
  updateGroup: (id: string, name: string, contactIds: string[]) => request<{ id: string }>('PUT', `/api/groups/${id}`, { name, contactIds }),
  deleteGroup: (id: string) => request<void>('DELETE', `/api/groups/${id}`),

  createNote: (conversationId: string, body: string, messageId?: string | null, quote?: QuoteSelector) =>
    request<NoteDto>('POST', '/api/notes', { conversationId, body, ...(messageId ? { messageId } : {}), ...(quote && messageId ? { quote } : {}) }),
  annotations: (messageId: string) => request<AnnotationMarkDto[]>('GET', `/api/messages/${messageId}/annotations`),
  updateNote: (id: string, body: string) => request<NoteDto>('PATCH', `/api/notes/${id}`, { body }),
  deleteNote: (id: string) => request<void>('DELETE', `/api/notes/${id}`),
  uploadResource: (conversationId: string, file: File) => upload(`/api/conversations/${conversationId}/resources`, file),
  /** Risorsa comune a tutte le conversazioni del progetto. */
  uploadProjectResource: (projectId: string, file: File) => upload(`/api/projects/${projectId}/resources`, file),
  deleteResource: (id: string) => request<void>('DELETE', `/api/resources/${id}`),
  projectResources: (projectId: string) => request<ResourceDto[]>('GET', `/api/projects/${projectId}/resources`),

  setImportant: (messageId: string, important: boolean) =>
    request<{ activityIds: string[] }>('POST', `/api/messages/${messageId}/important`, { important }),

  createDraft: (input: Partial<Omit<DraftDto, 'id' | 'attachments' | 'updatedAt'>>) => request<DraftDto>('POST', '/api/drafts', input),
  draft: (id: string) => request<DraftDto>('GET', `/api/drafts/${id}`),
  conversationDrafts: (conversationId: string) => request<DraftDto[]>('GET', `/api/conversations/${conversationId}/drafts`),
  updateDraft: (id: string, patch: DraftPatch) => request<DraftDto>('PUT', `/api/drafts/${id}`, patch),
  deleteDraft: (id: string) => request<void>('DELETE', `/api/drafts/${id}`),
  addDraftResource: (id: string, resourceId: string) => request<DraftDto>('POST', `/api/drafts/${id}/resources`, { resourceId }),
  removeDraftAttachment: (id: string, attId: string) => request<DraftDto>('DELETE', `/api/drafts/${id}/attachments/${attId}`),
  sendDraft: (id: string, urgent: boolean) =>
    request<{ activityId: string; conversationId: string; messageId: string }>('POST', `/api/drafts/${id}/send`, { urgent }),
  search: (q: string, scope: SearchScope) => request<SearchResults>('GET', `/api/search?q=${encodeURIComponent(q)}&scope=${encodeURIComponent(scope)}`),
  assistantThread: (q: AssistantScope) => request<AssistantMessageDto[]>('GET', `/api/assistant/thread?${scopeQuery(q)}`),
  clearAssistantThread: (q: AssistantScope) => request<void>('DELETE', `/api/assistant/thread?${scopeQuery(q)}`),
  replyIdeas: (conversationId: string) => request<ReplyIdea[]>('GET', `/api/conversations/${conversationId}/reply-ideas`),
  setSummary: (conversationId: string, summary: string) => request<{ ok: true }>('PUT', `/api/conversations/${conversationId}/summary`, { summary }),
  /** Risposta dell'assistente in streaming: onPiece riceve i pezzi man mano. */
  assistantChat: async (input: AssistantChatInput, onPiece: (piece: string) => void, signal?: AbortSignal): Promise<string> => {
    const res = await fetch('/api/assistant/chat', {
      method: 'POST',
      headers: { 'x-mmw': '1', 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += value;
      onPiece(value);
    }
    return out;
  },
  /** Domanda all'assistente su più conversazioni (dalla ricerca), in streaming. */
  assistantAsk: async (
    question: string,
    sources: { conversationId: string; messageId?: string }[],
    onPiece: (piece: string) => void,
    signal?: AbortSignal,
    onSources?: (found: AskSource[]) => void,
  ): Promise<string> => {
    const res = await fetch('/api/assistant/ask', {
      method: 'POST',
      headers: { 'x-mmw': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ question, sources }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
    try {
      const found = JSON.parse(decodeURIComponent(res.headers.get('x-mmw-sources') ?? '%5B%5D')) as AskSource[];
      if (found.length) onSources?.(found);
    } catch {}
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += value;
      onPiece(value);
    }
    return out;
  },
  uploadDraftFile: async (id: string, file: File): Promise<DraftDto> => {
    const res = await fetch(`/api/drafts/${id}/attachments?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'x-mmw': '1', 'content-type': 'application/octet-stream', 'x-file-type': file.type || '' },
      body: file,
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
    return (await res.json()) as DraftDto;
  },
};
