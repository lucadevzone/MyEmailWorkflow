import { z } from 'zod';
import { DEFAULT_SETTINGS, type SettingsDto } from '@mmw/shared';
import type { Db } from '../db/client.ts';
import { settings } from '../db/schema.ts';
import { now } from '../lib/ids.ts';
import { config } from '../config.ts';

/** Il modello scelto nelle impostazioni diventa quello usato da tutte le chiamate all'LLM. */
export function applyLlmModel(s: SettingsDto) {
  config.ollama.llmModel = s.llmModel || config.defaultLlmModel;
}

export const settingsPatchSchema = z
  .object({
    activityBatchMinutes: z.number().int().min(1).max(24 * 60),
    initialSyncDays: z.number().int().min(1).max(3650),
    llmModel: z.string().trim().min(1).max(120).nullable(),
    composeFormat: z.enum(['text', 'html']),
    composeFont: z.enum(['sans', 'serif', 'mono']),
    composeFontSize: z.enum(['small', 'normal', 'large']),
    replyIncludeQuote: z.boolean(),
  })
  .partial();

export class SettingsService {
  constructor(private db: Db) {}

  get(): SettingsDto {
    const rows = this.db.select().from(settings).all();
    const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
    const parsed = settingsPatchSchema.safeParse(stored);
    return { ...DEFAULT_SETTINGS, ...(parsed.success ? parsed.data : {}) };
  }

  update(patch: z.infer<typeof settingsPatchSchema>): SettingsDto {
    const t = now();
    this.db.transaction((tx) => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        tx.insert(settings)
          .values({ key, value: JSON.stringify(value), updatedAt: t })
          .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(value), updatedAt: t } })
          .run();
      }
    });
    const result = this.get();
    applyLlmModel(result);
    return result;
  }
}
