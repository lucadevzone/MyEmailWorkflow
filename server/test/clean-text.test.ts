import { describe, expect, it } from 'vitest';
import { cleanBody, normalizeSubject } from '../src/ingest/clean-text.ts';
import { detectNoise } from '../src/ingest/noise.ts';

describe('cleanBody', () => {
  it('taglia la citazione italiana di Gmail', () => {
    const body = 'Va bene, ci vediamo giovedì.\n\nIl giorno mer 7 ott 2026 alle ore 10:00 Mario Rossi <mario@x.it> ha scritto:\n> Ci vediamo?\n> Ciao';
    expect(cleanBody(body)).toBe('Va bene, ci vediamo giovedì.');
  });

  it("taglia la citazione inglese spezzata su due righe", () => {
    const body = 'Sounds good.\n\nOn Wed, Oct 7, 2026 at 10:00 AM Jane Doe <jane@example.com>\nwrote:\n> Shall we meet?';
    expect(cleanBody(body)).toBe('Sounds good.');
  });

  it('taglia il blocco intestazioni di Outlook', () => {
    const body = 'Ok per me.\n\nDa: Mario Rossi <mario@x.it>\nInviato: mercoledì 7 ottobre 2026 10:00\nA: Luca <l@x.it>\nOggetto: Riunione\n\nTesto vecchio';
    expect(cleanBody(body)).toBe('Ok per me.');
  });

  it('non taglia una riga che inizia per "A:" nel testo', () => {
    const body = 'Elenco:\nA: primo punto\nB: secondo punto';
    expect(cleanBody(body)).toBe(body);
  });

  it('rimuove firma standard e "Inviato da iPhone"', () => {
    expect(cleanBody('Grazie!\n-- \nLuca Sabatucci\nICAR-CNR')).toBe('Grazie!');
    expect(cleanBody('Arrivo.\n\nInviato da iPhone')).toBe('Arrivo.');
  });

  it('rimuove i segnaposto delle immagini', () => {
    expect(cleanBody('[image: Google]\nNuovo accesso')).toBe('Nuovo accesso');
  });

  it('rimuove righe quotate sparse (risposta inline)', () => {
    expect(cleanBody('> domanda 1\nrisposta 1\n> domanda 2\nrisposta 2')).toBe('risposta 1\nrisposta 2');
  });
});

describe('normalizeSubject', () => {
  it('toglie prefissi multipli di risposta e inoltro', () => {
    expect(normalizeSubject('Re: R: Fwd: I: Riunione progetto')).toBe('Riunione progetto');
    expect(normalizeSubject('RE[2]: Budget')).toBe('Budget');
    expect(normalizeSubject('Report finale')).toBe('Report finale');
  });
});

describe('detectNoise', () => {
  const h = (o: Record<string, string>) => new Map(Object.entries(o));
  it('riconosce newsletter e mittenti automatici', () => {
    expect(detectNoise({ headers: h({ 'list-unsubscribe': '<mailto:x>' }), fromAddress: 'news@shop.it' }).isNoise).toBe(true);
    expect(detectNoise({ headers: h({}), fromAddress: 'no-reply@accounts.google.com' }).isNoise).toBe(true);
    expect(detectNoise({ headers: h({ precedence: 'bulk' }), fromAddress: 'a@b.it' }).isNoise).toBe(true);
    expect(detectNoise({ headers: h({}), fromAddress: 'google-noreply@google.com' }).isNoise).toBe(true);
    expect(detectNoise({ headers: h({ 'feedback-id': 'x:y:z' }), fromAddress: 'wix-team@emails.wix.com' }).isNoise).toBe(true);
  });

  it('legge List-Unsubscribe nel formato raggruppato di mailparser', () => {
    const headers = new Map<string, unknown>([['list', { unsubscribe: { mail: 'u@x' } }]]);
    expect(detectNoise({ headers, fromAddress: 'team@usemusicfy.com' }).isNoise).toBe(true);
    const discussion = new Map<string, unknown>([['list', { id: { id: 'dev.x.org' } }]]);
    expect(detectNoise({ headers: discussion, fromAddress: 'mario@x.org' }).isNoise).toBe(false);
  });
  it('non marca la posta personale né le mailing list di discussione', () => {
    expect(detectNoise({ headers: h({}), fromAddress: 'mario.rossi@unipa.it' }).isNoise).toBe(false);
    expect(detectNoise({ headers: h({ 'list-id': '<dev.lists.x.org>' }), fromAddress: 'mario@x.org' }).isNoise).toBe(false);
  });
});
