// Opzioni comuni a tutte le chiamate a Ollama: stesso contesto (niente ricaricamenti) e permanenza
// in memoria scelta nelle impostazioni (niente attese dopo una pausa).

import { config } from '../config.ts';

export function keepAlive(): string | number {
  const m = config.ollama.keepAliveMinutes;
  return m < 0 ? -1 : `${m}m`;
}

export function llmRequest(temperature: number) {
  return { keep_alive: keepAlive(), options: { temperature, num_ctx: config.ollama.numCtx } };
}

/** Caratteri per token, stima prudente per l'italiano: serve a stare dentro il contesto. */
export const CHARS_PER_TOKEN = 3;

/** Prompt arrivato quasi al limite del contesto: probabilmente Ollama ne ha tagliato una parte. */
export function warnIfTruncated(promptTokens: number | undefined, where: string) {
  if (promptTokens && promptTokens >= config.ollama.numCtx * 0.97) {
    console.warn(`[ollama] ${where}: prompt di ${promptTokens} token al limite del contesto (${config.ollama.numCtx}): parte del testo è stata tagliata`);
  }
}
