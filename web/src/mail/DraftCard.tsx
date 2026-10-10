import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, Paperclip, Quote, Send, Type, X } from 'lucide-react';
import type { Editor } from '@tiptap/react';
import { COMPOSE_FONTS, COMPOSE_FONT_SIZES, type ConversationDetail, type SignatureDto, type DraftAttachment, type DraftDto, type SettingsDto } from '@mmw/shared';
import { api } from '../api.ts';
import { fileSize } from '../lib/format.ts';
import { Ic } from '../ui/Ic.tsx';
import { usePeopleIndex } from '../ui/People.tsx';
import { useConfirm } from '../ui/confirm.tsx';
import { useToast } from '../ui/toast.tsx';
import { RecipientField } from './RecipientField.tsx';
import { RichEditor, textToHtml } from '../ui/RichEditor.tsx';
import type { DraftHandle } from './Assistant.tsx';
import { NEW_DRAFT, normalizeSubject, replyRecipients, type DraftSeed } from './seed.ts';

interface Fields {
  projectId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  format: 'text' | 'html';
  bodyHtml: string | null;
  includeQuote: boolean;
}

export interface SentInfo {
  conversationId: string;
  projectId: string;
}

const SAVE_DELAY = 800;

const SIG_SEP = '-- ';

/**
 * Campi iniziali di una bozza non ancora salvata, dal seme, dalla conversazione e dalle impostazioni
 * di composizione. La firma scelta per il progetto va in fondo, modificabile come il resto.
 */
function initialFields(seed: DraftSeed, d: ConversationDetail | null, isMe: (e: string) => boolean, settings: SettingsDto, signature: SignatureDto | undefined): Fields {
  const projectId = seed.projectId ?? d?.projectId ?? null;
  const format = settings.composeFormat;
  const start = seed.body ?? '';
  const sigText = signature?.text ?? null;
  const body = sigText ? `${start}\n\n${SIG_SEP}\n${sigText}` : start;
  const bodyHtml =
    format === 'html' ? (start ? textToHtml(start) : '<p></p>') + (sigText ? `<p>${SIG_SEP}</p>${signature?.html || textToHtml(sigText)}` : '') : null;
  const base = {
    projectId,
    to: seed.to ?? [],
    cc: [] as string[],
    bcc: [] as string[],
    subject: seed.subject ?? '',
    body,
    format,
    bodyHtml,
    includeQuote: !!seed.replyToMessageId && settings.replyIncludeQuote,
  };
  if (seed.forwardMessageId) return base;
  const parent = seed.replyToMessageId ? d?.messages.find((m) => m.id === seed.replyToMessageId) : undefined;
  if (parent) {
    const r = replyRecipients(parent, seed.replyAll ?? true, isMe);
    return { ...base, to: r.to, cc: r.cc, subject: `Re: ${normalizeSubject(parent.subject ?? d?.subject)}` };
  }
  return base;
}

const fieldsOf = (x: DraftDto): Fields => ({
  projectId: x.projectId,
  to: x.to,
  cc: x.cc,
  bcc: x.bcc,
  subject: x.subject,
  body: x.body,
  format: x.format,
  bodyHtml: x.bodyHtml,
  includeQuote: x.includeQuote,
});

/** Bozza nel carosello (D11): A, Cc/Ccn, Oggetto, Testo, allegati, fascia di invio. Si salva da sola. */
export function DraftCard({ draftId, seed, d, onCreated, onSaved, onSent, onCancel, handle }: {
  draftId: string;
  /** Per l'assistente: leggere il testo e inserirvi le proposte. */
  handle?: React.RefObject<DraftHandle | null>;
  seed: DraftSeed;
  d: ConversationDetail | null;
  /** La bozza è stata creata sul server (alla prima modifica). */
  onCreated: (id: string) => void;
  onSaved: (at: number) => void;
  onSent: (info: SentInfo) => void;
  onCancel: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const ask = useConfirm();
  const people = usePeopleIndex();
  const isNew = draftId === NEW_DRAFT;
  const saved = useQuery({ queryKey: ['draft', draftId], queryFn: () => api.draft(draftId), enabled: !isNew, staleTime: Infinity });
  const projectsQ = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const projects = projectsQ.data ?? [];
  const accountsQ = useQuery({ queryKey: ['accounts'], queryFn: api.accounts });
  const accounts = accountsQ.data ?? [];
  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const settings = settingsQ.data;
  const signaturesQ = useQuery({ queryKey: ['signatures'], queryFn: api.signatures });

  const [f, setF] = useState<Fields | null>(null);
  // Testo con cui la bozza nasce (firma compresa): se resta così, la bozza è "vuota".
  const initialBody = useRef<string | null>(null);
  // Bozza nuova: nasce quando impostazioni, progetti e firme sono pronti (servono formato e firma).
  useEffect(() => {
    if (!isNew || f || !settings || !signaturesQ.data || !projectsQ.data) return;
    const projectId = seed.projectId ?? d?.projectId ?? null;
    const sigId = projectsQ.data.find((p) => p.id === projectId)?.signatureId;
    const init = initialFields(seed, d, people.isMe, settings, signaturesQ.data.find((s) => s.id === sigId));
    initialBody.current = init.body;
    setF(init);
  }, [isNew, f, settings, signaturesQ.data, projectsQ.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const editor = useRef<Editor | null>(null);
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [showCc, setShowCc] = useState(false);
  const [urgent, setUrgent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const idRef = useRef<string | null>(isNew ? null : draftId);
  const dirty = useRef(false);
  const done = useRef(false);
  const timer = useRef<number | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef<Fields | null>(f);
  latest.current = f;
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const replyTo = isNew ? seed.replyToMessageId : saved.data?.replyToMessageId;
  const forwardOf = isNew ? seed.forwardMessageId : saved.data?.forwardMessageId;

  // Bozza esistente: i campi arrivano dal server una volta sola.
  useEffect(() => {
    if (!saved.data || f) return;
    setF(fieldsOf(saved.data));
    initialBody.current = null;
    setAttachments(saved.data.attachments);
    setShowCc(saved.data.cc.length > 0 || saved.data.bcc.length > 0);
    onSaved(saved.data.updatedAt);
  }, [saved.data, f, onSaved]);

  /** Salva subito (creando la bozza se serve) e restituisce il suo id. */
  const save = (): Promise<string> => {
    const run = chain.current.then(async () => {
      const cur = latest.current!;
      const res = idRef.current
        ? await api.updateDraft(idRef.current, cur)
        : await api.createDraft({
            ...cur,
            conversationId: d?.id ?? null,
            replyToMessageId: seed.replyToMessageId ?? null,
            forwardMessageId: seed.forwardMessageId ?? null,
          });
      dirty.current = false;
      if (!idRef.current) {
        idRef.current = res.id;
        qc.setQueryData(['draft', res.id], res);
        onCreated(res.id);
        for (const k of [['conversations'], ['drafts']]) qc.invalidateQueries({ queryKey: k });
      }
      onSaved(res.updatedAt);
      return res.id;
    });
    chain.current = run.catch(() => {});
    return run;
  };

  // Salvataggio automatico poco dopo l'ultima modifica.
  useEffect(() => {
    if (!f || !dirty.current || done.current) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      save().catch((e: Error) => setError(e.message));
    }, SAVE_DELAY);
  }, [f]); // eslint-disable-line react-hooks/exhaustive-deps

  // Uscendo con modifiche non ancora salvate si salva comunque (regola 4).
  useEffect(
    () => () => {
      if (timer.current) {
        window.clearTimeout(timer.current);
        timer.current = null;
        if (!done.current) void save().catch(() => {});
      }
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Risposta da Da smistare o nuova mail senza progetto: si propone il più probabile.
  const recipients = f ? [...f.to, ...f.cc] : [];
  const needsProject = d ? !d.projectId : !seed.projectId;
  const { data: suggestions = [] } = useQuery({
    queryKey: ['suggest-project', recipients.join(',')],
    queryFn: () => api.suggestProject(recipients),
    enabled: needsProject && recipients.length > 0 && !!f && !f.projectId,
  });
  useEffect(() => {
    if (f && !f.projectId && suggestions[0]) setF({ ...f, projectId: suggestions[0].projectId });
  }, [f, suggestions]);

  const set = (patch: Partial<Fields>) => {
    dirty.current = true;
    setError(null);
    setF((cur) => (cur ? { ...cur, ...patch } : cur));
  };

  // Bozza che parte con del testo (citazione, proposta): il cursore va in fondo, pronto per scrivere.
  const caretPlaced = useRef(false);
  useEffect(() => {
    const el = textarea.current;
    if (!el || caretPlaced.current || !f?.body || f.to.length === 0) return;
    caretPlaced.current = true;
    el.focus();
    // Prima della firma: il testo nuovo si scrive sopra.
    const sig = el.value.lastIndexOf(`\n\n${SIG_SEP}\n`);
    const at = isNew && sig >= 0 ? sig : el.value.length;
    el.setSelectionRange(at, at);
  }, [f]);

  // L'assistente inserisce le proposte dove sta il cursore (o in fondo).
  useEffect(() => {
    if (!handle) return;
    handle.current = {
      body: () => latest.current?.body ?? '',
      insert: (text) => {
        if (latest.current?.format === 'html' && editor.current) {
          editor.current.chain().focus().insertContent(textToHtml(text)).run();
          return;
        }
        const cur = latest.current?.body ?? '';
        const el = textarea.current;
        const at = el && document.activeElement === el ? el.selectionStart : el && el.selectionStart > 0 ? el.selectionStart : cur.length;
        const before = cur.slice(0, at);
        const after = cur.slice(at);
        const sepBefore = before && !before.endsWith('\n') ? '\n\n' : '';
        const sepAfter = after && !after.startsWith('\n') ? '\n\n' : '';
        set({ body: before + sepBefore + text + sepAfter + after });
      },
    };
    return () => {
      handle.current = null;
    };
  });

  const active = useMemo(() => projects.filter((p) => !p.archived), [projects]);
  const project = projects.find((p) => p.id === f?.projectId);
  const from = accounts.find((a) => a.id === project?.outgoingAccountId);
  const resources = useQuery({
    queryKey: ['project-resources', f?.projectId],
    queryFn: () => api.projectResources(f!.projectId!),
    enabled: resourcesOpen && !!f?.projectId,
  });

  if (!f) {
    return (
      <article className="pm-draft" aria-label="Bozza">
        <div className="pm-empty">{saved.isError ? 'Bozza non trovata.' : 'Caricamento…'}</div>
      </article>
    );
  }

  const withId = async (fn: (id: string) => Promise<DraftDto>) => {
    setBusy(true);
    try {
      const id = await save();
      const res = await fn(id);
      setAttachments(res.attachments);
      onSaved(res.updatedAt);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!f.to.length && !f.cc.length && !f.bcc.length) return setError('Aggiungi almeno un destinatario.');
    if (!f.projectId) return setError('Scegli il progetto da cui scrivere.');
    setBusy(true);
    try {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = null;
      const id = await save();
      done.current = true;
      const r = await api.sendDraft(id, urgent);
      for (const k of [['conversations'], ['conversation', r.conversationId], ['activities'], ['projects'], ['counts'], ['tasks'], ['drafts']]) qc.invalidateQueries({ queryKey: k });
      if (d) qc.invalidateQueries({ queryKey: ['conversation', d.id] });
      toast({
        text: urgent ? 'Invio in corso…' : 'Messaggio in coda di invio',
        action: urgent ? undefined : { label: 'Annulla', run: () => void api.cancelActivity(r.activityId).then(() => qc.invalidateQueries()) },
      });
      onSent({ conversationId: r.conversationId, projectId: f.projectId });
    } catch (e) {
      done.current = false;
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const cancel = async () => {
    const empty = (!f.body.trim() || f.body === initialBody.current) && attachments.length === 0;
    if (!empty && !(await ask({ message: 'Eliminare la bozza?', okLabel: 'Elimina', danger: true }))) return;
    done.current = true;
    if (timer.current) window.clearTimeout(timer.current);
    await chain.current;
    if (idRef.current) {
      await api.deleteDraft(idRef.current).catch(() => {});
      for (const k of [['conversations'], ['drafts']]) qc.invalidateQueries({ queryKey: k });
      if (d) qc.invalidateQueries({ queryKey: ['conversation', d.id] });
    }
    onCancel();
  };

  return (
    <article
      className="pm-draft"
      aria-label={forwardOf ? 'Inoltro' : replyTo ? 'Nuova risposta' : 'Nuova mail'}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void send();
        }
      }}
    >
      <div className="pm-draft__scroll">
        {needsProject && (
          <div className="pm-draft__row">
            <span className="pm-draft__label">Progetto</span>
            <select className="pm-input" style={{ height: 32 }} value={f.projectId ?? ''} onChange={(e) => set({ projectId: e.target.value || null })} aria-label="Progetto da cui scrivere">
              <option value="">Scegli un progetto…</option>
              {active.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {from && <span style={{ color: 'var(--ink-muted)', fontSize: 'var(--fs-md)' }}>da {from.email}</span>}
            {replyTo && <span style={{ color: 'var(--ink-muted)', fontSize: 'var(--fs-md)' }}>· la conversazione passerà nel progetto</span>}
          </div>
        )}
        <RecipientField
          label="A"
          value={f.to}
          onChange={(to) => set({ to })}
          autoFocus={f.to.length === 0}
          extra={
            !showCc && (
              <button type="button" className="pm-btn pm-btn--ghost pm-btn--xs" onClick={() => setShowCc(true)}>
                Cc / Ccn
              </button>
            )
          }
        />
        {showCc && <RecipientField label="Cc" value={f.cc} onChange={(cc) => set({ cc })} />}
        {showCc && <RecipientField label="Ccn" value={f.bcc} onChange={(bcc) => set({ bcc })} />}
        <label className="pm-draft__row" style={{ height: 48, paddingTop: 0, paddingBottom: 0 }}>
          <span className="pm-draft__label">Oggetto</span>
          <input className="pm-draft__subject" value={f.subject} onChange={(e) => set({ subject: e.target.value })} />
        </label>
        {f.format === 'html' ? (
          <RichEditor
            key={`rich-${draftId}`}
            initialHtml={f.bodyHtml ?? textToHtml(f.body)}
            onChange={(bodyHtml, body) => set({ bodyHtml, body })}
            font={settings ? COMPOSE_FONTS[settings.composeFont].css : undefined}
            size={settings ? COMPOSE_FONT_SIZES[settings.composeFontSize].css : undefined}
            autoFocus={f.to.length > 0 ? 'start' : false}
            onReady={(e) => (editor.current = e)}
          />
        ) : (
          <textarea
            ref={textarea}
            className="pm-draft__body"
            aria-label="Testo"
            value={f.body}
            onChange={(e) => set({ body: e.target.value })}
            autoFocus={f.to.length > 0}
            placeholder={replyTo ? 'Scrivi la risposta…' : 'Scrivi il messaggio…'}
          />
        )}
        {attachments.length > 0 && (
          <div className="pm-draft__files">
            {attachments.map((a) => (
              <span key={a.id} className="pm-infochip">
                <Ic icon={Paperclip} size={15} />
                <span className="pm-truncate" style={{ maxWidth: 240 }}>{a.filename}</span>
                <span style={{ color: 'var(--ink-muted)' }}>{fileSize(a.size)}</span>
                <button
                  type="button"
                  className="pm-personchip__remove"
                  aria-label={`Togli ${a.filename}`}
                  onClick={() => void withId((id) => api.removeDraftAttachment(id, a.id))}
                >
                  <Ic icon={X} size={15} />
                </button>
              </span>
            ))}
          </div>
        )}
        {forwardOf && <div style={{ padding: '0 24px 12px', color: 'var(--ink-muted)', fontSize: 'var(--fs-md)' }}>Il messaggio inoltrato e i suoi allegati vengono aggiunti in fondo all'invio.</div>}
        <div className="pm-draft__tools">
          <button type="button" className="pm-btn pm-btn--secondary pm-btn--sm" onClick={() => fileInput.current?.click()} disabled={busy}>
            <Ic icon={Paperclip} size={15} /> Allega file
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              void withId(async (id) => {
                let last: DraftDto | null = null;
                for (const file of files) last = await api.uploadDraftFile(id, file);
                return last ?? api.draft(id);
              });
            }}
          />
          <button
            type="button"
            className="pm-btn pm-btn--secondary pm-btn--sm"
            onClick={() => setResourcesOpen(!resourcesOpen)}
            disabled={!f.projectId || busy}
            aria-expanded={resourcesOpen}
            title={f.projectId ? undefined : 'Scegli prima il progetto'}
          >
            <Ic icon={FolderOpen} size={15} /> Da risorse del progetto
          </button>
          <button
            type="button"
            className="pm-btn pm-btn--secondary pm-btn--sm"
            aria-pressed={f.format === 'html'}
            title={f.format === 'html' ? 'Passa a testo semplice (la formattazione si perde)' : 'Passa a testo formattato'}
            style={f.format === 'html' ? { background: 'var(--surface-chip)', fontWeight: 600 } : undefined}
            onClick={async () => {
              if (f.format === 'html') {
                if (f.body.trim() && !(await ask({ message: 'Passare a testo semplice? La formattazione si perde.', okLabel: 'Testo semplice' }))) return;
                set({ format: 'text', bodyHtml: null });
              } else {
                set({ format: 'html', bodyHtml: textToHtml(f.body) });
              }
            }}
          >
            <Ic icon={Type} size={15} /> Formattato
          </button>
          {replyTo && (
            <button type="button" className="pm-btn pm-btn--secondary pm-btn--sm" aria-pressed={f.includeQuote} onClick={() => set({ includeQuote: !f.includeQuote })} style={f.includeQuote ? { background: 'var(--surface-chip)', fontWeight: 600 } : undefined}>
              <Ic icon={Quote} size={15} /> Includi testo citato
            </button>
          )}
          {resourcesOpen && (
            <div className="pm-menu-pop" style={{ bottom: '100%', left: 24 }} role="menu">
              {resources.isLoading && <div className="pm-empty" style={{ padding: 12 }}>Caricamento…</div>}
              {resources.data?.length === 0 && <div className="pm-empty" style={{ padding: 12 }}>Nessun file tra le risorse del progetto.</div>}
              {resources.data?.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="menuitem"
                  className="pm-menu-pop__item"
                  onClick={() => {
                    setResourcesOpen(false);
                    void withId((id) => api.addDraftResource(id, r.id));
                  }}
                >
                  <Ic icon={Paperclip} size={15} />
                  <span className="pm-truncate" style={{ flex: 1 }}>{r.title}</span>
                  {r.size != null && <span style={{ color: 'var(--ink-muted)', fontSize: 'var(--fs-sm)' }}>{fileSize(r.size)}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        {error && <div className="pm-draft__error" role="alert">{error}</div>}
      </div>
      <div className="pm-send">
        <label className="pm-send__urgent">
          <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} /> Urgente
        </label>
        <span style={{ flex: 1 }} />
        <button type="button" className="pm-btn pm-btn--danger" onClick={() => void cancel()} disabled={busy}>
          Cancella
        </button>
        <button type="button" className="pm-btn pm-btn--primary" style={{ height: 40, padding: '0 18px', borderRadius: 'var(--r-lg)' }} onClick={() => void send()} disabled={busy}>
          <Ic icon={Send} size={17} /> Invio
        </button>
      </div>
    </article>
  );
}
