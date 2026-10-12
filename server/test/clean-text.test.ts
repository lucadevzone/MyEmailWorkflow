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
  const noise = (o: Record<string, string>, from: string, subject?: string) => detectNoise({ headers: h(o), fromAddress: from, subject }).isNoise;

  it('newsletter e invii massivi: un indizio forte o due deboli', () => {
    expect(noise({ precedence: 'bulk' }, 'a@b.it')).toBe(true);
    expect(noise({ 'list-unsubscribe': '<mailto:x>' }, 'newsletter@shop.it')).toBe(true); // mittente di marketing
    expect(noise({ 'list-unsubscribe': '<mailto:x>', 'list-id': '<promo.shop.it>' }, 'info@shop.it')).toBe(true); // invio a lista
    expect(noise({ 'feedback-id': 'x', 'list-unsubscribe': '<mailto:x>' }, 'no-reply@youtube.com')).toBe(true);
    // facile.it: List-Unsubscribe, Precedence bulk, Auto-Submitted, Feedback-ID
    expect(noise({ 'list-unsubscribe': '<x>', precedence: 'bulk', 'auto-submitted': 'auto-generated', 'feedback-id': 'x' }, 'preventivo@newsletter.facile.it', 'Il tuo preventivo')).toBe(true);
  });

  it('itch.io: Mailgun + X-Feedback-ID + dominio di invio massivo', () => {
    expect(noise({ 'x-mailgun-sid': 'x', 'x-feedback-id': 'y', 'x-mailgun-track-opens': 'yes' }, 'postmaster@updates.itch.io', 'WatcherDM released a new Character Sheet')).toBe(true);
  });

  it('notifiche di servizio senza indizi promozionali restano fuori dalle News', () => {
    // Ricevuta del veterinario: Amazon SES + Feedback-ID + noreply, ma niente disiscrizione né tracciamento.
    expect(noise({ 'feedback-id': 'x', 'x-ses-outgoing': 'y' }, 'noreply@smartvet.it', 'Doc.Ref.3422238')).toBe(false);
    // Documenti firmati in palestra: SendGrid + mittente notifiche.
    expect(noise({ 'x-sg-eid': 'x' }, 'notifications@notifications.virginactive.com', 'Ecco i documenti che hai firmato!')).toBe(false);
  });

  it('un indizio debole da solo non basta (casi veri dalla casella personale)', () => {
    expect(noise({ 'feedback-id': 'x:y:z' }, 'fatture@vodafone.it', 'Emissione fattura Vodafone')).toBe(false);
    expect(noise({}, 'no-reply@accounts.google.com')).toBe(false);
    expect(noise({ 'list-unsubscribe': '<mailto:x>' }, 'mario@studio.it')).toBe(false);
  });

  it('oggetto transazionale: servono indizi forti', () => {
    // Condominio: List-Unsubscribe + Feedback-ID, ma è un avviso di pagamento.
    expect(noise({ 'list-unsubscribe': '<x>', 'feedback-id': 'x' }, 'info@studioliberta.it', 'Condominio Via Arimondi 1/z Avviso di pagamento quota ordinaria Ottobre 2026')).toBe(false);
    // Preply: SendGrid + noreply, ma è un messaggio della tua insegnante.
    expect(noise({ 'x-sg-eid': 'x' }, 'noreply@trans.preply.com', 'Nuovo messaggio da Mariska')).toBe(false);
    // Senza oggetto transazionale, con un indizio promozionale (disiscrizione), è rumore.
    expect(noise({ 'x-sg-eid': 'x', 'list-unsubscribe': '<x>' }, 'noreply@trans.preply.com', 'Scopri le nuove offerte')).toBe(true);
    // Transazionale ma con indizi forti di marketing: resta rumore.
    expect(noise({ precedence: 'bulk' }, 'offerte@shop.it', 'Conferma la tua iscrizione e ricevi lo sconto')).toBe(true);
  });

  it('legge List-Unsubscribe nel formato raggruppato di mailparser', () => {
    const headers = new Map<string, unknown>([['list', { unsubscribe: { mail: 'u@x' }, id: { id: 'promo.musicfy' } }]]);
    expect(detectNoise({ headers, fromAddress: 'team@usemusicfy.com' }).isNoise).toBe(true);
    const discussion = new Map<string, unknown>([['list', { id: { id: 'dev.x.org' } }]]);
    expect(detectNoise({ headers: discussion, fromAddress: 'mario@x.org' }).isNoise).toBe(false);
  });

  it('non marca la posta personale né le mailing list di discussione', () => {
    expect(noise({}, 'mario.rossi@unipa.it')).toBe(false);
    expect(noise({ 'list-id': '<dev.lists.x.org>' }, 'mario@x.org')).toBe(false);
  });
});
