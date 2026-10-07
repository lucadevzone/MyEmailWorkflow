-- Ricerca full-text sui messaggi (indice popolato dall'ingest).
CREATE VIRTUAL TABLE `message_fts` USING fts5(
  `message_id` UNINDEXED,
  `subject`,
  `body`,
  `participants`,
  tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
-- Vettori di embedding dei chunk (sqlite-vec). Dimensione = modello bge-m3.
-- Cambiare modello di embedding richiede di ricreare questa tabella e reindicizzare.
CREATE VIRTUAL TABLE `chunk_vec` USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding float[1024]
);
