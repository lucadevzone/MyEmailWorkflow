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

export const api = {
  health: () => request<HealthDto>('GET', '/api/health'),
  accounts: () => request<AccountDto[]>('GET', '/api/accounts'),
  createAccount: (input: CreateAccountInput) => request<AccountDto>('POST', '/api/accounts', input),
  deleteAccount: (id: string) => request<void>('DELETE', `/api/accounts/${id}`),
  testAccount: (id: string) => request<ConnectionTestResult>('POST', `/api/accounts/${id}/test`),
  settings: () => request<SettingsDto>('GET', '/api/settings'),
  syncStatus: () => request<SyncStatusDto[]>('GET', '/api/sync/status'),
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
  updateTask: (id: string, patch: Partial<Pick<TaskDto, 'title' | 'details' | 'dueDate' | 'status'>>) => request<TaskDto>('PATCH', `/api/tasks/${id}`, patch),
  moveTask: (id: string, afterId: string | null) => request<TaskDto>('POST', `/api/tasks/${id}/move`, { afterId }),
  deleteTask: (id: string) => request<void>('DELETE', `/api/tasks/${id}`),
  acceptSuggestion: (id: string, projectId?: string) => request<{ conversationId: string }>('POST', `/api/suggestions/${id}/accept`, { projectId }),
  rejectSuggestion: (id: string) => request<{ conversationId: string }>('POST', `/api/suggestions/${id}/reject`),
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

  createNote: (conversationId: string, body: string) => request<NoteDto>('POST', '/api/notes', { conversationId, body }),
  updateNote: (id: string, body: string) => request<NoteDto>('PATCH', `/api/notes/${id}`, { body }),
  deleteNote: (id: string) => request<void>('DELETE', `/api/notes/${id}`),
  uploadResource: async (conversationId: string, file: File): Promise<ResourceDto> => {
    const res = await fetch(`/api/conversations/${conversationId}/resources?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'x-mmw': '1', 'content-type': 'application/octet-stream', 'x-file-type': file.type || '' },
      body: file,
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
    return (await res.json()) as ResourceDto;
  },
  deleteResource: (id: string) => request<void>('DELETE', `/api/resources/${id}`),
};
