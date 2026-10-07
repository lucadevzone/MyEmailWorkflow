import type {
  AccountDto,
  ConversationDetail,
  ConversationListItem,
  ConversationView,
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
  conversations: (view: ConversationView, before?: number) =>
    request<ConversationListItem[]>('GET', `/api/conversations?view=${view}${before ? `&before=${before}` : ''}`),
  conversationCounts: () => request<{ inbox: number; noise: number; inboxUnread: number }>('GET', '/api/conversations/counts'),
  conversation: (id: string) => request<ConversationDetail>('GET', `/api/conversations/${id}`),
  setNoise: (id: string, isNoise: boolean) => request<{ ok: true }>('POST', `/api/conversations/${id}/noise`, { isNoise }),
  updateSettings: (patch: Partial<SettingsDto>) => request<SettingsDto>('PUT', '/api/settings', patch),
};
