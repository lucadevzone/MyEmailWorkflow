import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

const dataDir = path.resolve(repoRoot, env('MMW_DATA_DIR', './data'));

export const config = {
  repoRoot,
  port: Number(env('MMW_PORT', '4310')),
  // Solo loopback: l'app non deve mai essere raggiungibile dalla rete.
  host: '127.0.0.1',
  dataDir,
  dbPath: path.join(dataDir, 'mmw.sqlite'),
  blobDir: path.join(dataDir, 'blobs'),
  migrationsDir: path.resolve(repoRoot, 'server/drizzle'),
  ollama: {
    url: env('OLLAMA_URL', 'http://127.0.0.1:11434'),
    llmModel: env('OLLAMA_LLM_MODEL', 'llama3.1:8b'),
    embedModel: env('OLLAMA_EMBED_MODEL', 'bge-m3'),
  },
  /** Dimensione dei vettori di embedding. Deve combaciare con il modello (bge-m3 = 1024). */
  embedDim: 1024,
};
