import type { Db } from '../db/client.ts';
import { enqueueMissingEmbeddings } from './embed.ts';
import { enqueueMissingSummaries } from './summarize.ts';
import { enqueueMissingTaskExtraction } from './extract-tasks.ts';
import { enqueueMissingClassifications } from './classify.ts';

/** Rimette in coda tutta l'analisi mancante (indicizzazione su tutto, il resto dentro la finestra). */
export function enqueueMissingAnalysis(db: Db) {
  enqueueMissingEmbeddings(db);
  enqueueMissingSummaries(db);
  enqueueMissingTaskExtraction(db);
  enqueueMissingClassifications(db);
}
