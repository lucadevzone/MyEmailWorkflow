import type {
  AccountDto,
  ActivityQueueDto,
  ComposeInput,
  ConversationDetail,
  ConversationListItem,
  ConversationQuery,
  ProjectDto,
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
    if (q.archived) p.set('archived', '1');
    if (q.before) p.set('before', String(q.before));
    return request<ConversationListItem[]>('GET', `/api/conversations?${p}`);
  },
  conversationCounts: () => request<{ inbox: number; noise: number; inboxUnread: number }>('GET', '/api/conversations/counts'),
  conversation: (id: string) => request<ConversationDetail>('GET', `/api/conversations/${id}`),
  setNoise: (id: string, isNoise: boolean) => request<{ ok: true }>('POST', `/api/conversations/${id}/noise`, { isNoise }),
  markRead: (id: string) => request<{ activityIds: string[] }>('POST', `/api/conversations/${id}/read`),
  markUnread: (id: string) => request<{ activityIds: string[] }>('POST', `/api/conversations/${id}/unread`),
  archive: (id: string) => request<{ activityIds: string[] }>('POST', `/api/conversations/${id}/archive`),
  unarchive: (id: string) => request<{ ok: true }>('POST', `/api/conversations/${id}/unarchive`),
  trash: (id: string) => request<{ activityIds: string[] }>('POST', `/api/conversations/${id}/trash`),
  move: (id: string, projectId: string | null) =>
    request<{ previousProjectId: string | null }>('POST', `/api/conversations/${id}/move`, { projectId }),
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
};
