import { config } from '../config.ts';

/** Chiamata a Ollama con risposta JSON. */
export async function ollamaJson<T>(system: string, user: string, timeoutMs = 180_000): Promise<T> {
  const res = await fetch(`${config.ollama.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: config.ollama.llmModel,
      stream: false,
      format: 'json',
      options: { temperature: 0.2 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  const body = (await res.json()) as { message?: { content?: string } };
  return JSON.parse(body.message?.content ?? '{}') as T;
}
