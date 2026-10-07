import { config } from '../config.ts';

export interface OllamaStatus {
  ok: boolean;
  url: string;
  models: string[];
  error?: string;
}

export async function ollamaStatus(): Promise<OllamaStatus> {
  const url = config.ollama.url;
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false, url, models: [], error: `HTTP ${res.status}` };
    const body = (await res.json()) as { models?: { name: string }[] };
    return { ok: true, url, models: (body.models ?? []).map((m) => m.name) };
  } catch (err) {
    return { ok: false, url, models: [], error: (err as Error).message };
  }
}

/** "bge-m3" corrisponde a "bge-m3:latest". */
export function hasModel(models: string[], wanted: string): boolean {
  const norm = (n: string) => (n.includes(':') ? n : `${n}:latest`);
  return models.some((m) => norm(m) === norm(wanted));
}
