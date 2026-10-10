// Editor di testo formattato (TipTap) per mail HTML e firme: barra essenziale, niente stili inventati.
// Non controllato: il contenuto iniziale entra una volta, poi le modifiche escono con onChange(html, testo).

import { useEffect, useState } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Italic, Link2, List, ListOrdered, RemoveFormatting, Underline } from 'lucide-react';
import { Ic } from './Ic.tsx';

/** Testo semplice da HTML dell'editor: un a capo tra i blocchi. */
export function editorText(editor: Editor): string {
  return editor.getText({ blockSeparator: '\n' }).replace(/\n{3,}/g, '\n\n');
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Da testo semplice a paragrafi HTML (per passare una bozza da testo a formattata). */
export function textToHtml(text: string): string {
  if (!text.trim()) return '<p></p>';
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export function RichEditor({ initialHtml, onChange, placeholder, font, size, autoFocus, onReady, label = 'Testo', minHeight, boxed }: {
  initialHtml: string;
  onChange: (html: string, text: string) => void;
  placeholder?: string;
  font?: string;
  size?: string;
  /** 'start' mette il cursore in cima (prima della firma), 'end' in fondo. */
  autoFocus?: 'start' | 'end' | false;
  onReady?: (editor: Editor | null) => void;
  label?: string;
  minHeight?: number;
  /** Con bordo proprio (dentro una scheda, es. la firma). */
  boxed?: boolean;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        code: false,
        codeBlock: false,
        horizontalRule: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
      }),
    ],
    content: initialHtml || '<p></p>',
    autofocus: autoFocus || false,
    editorProps: { attributes: { class: 'pm-rich__content', 'aria-label': label, role: 'textbox', 'aria-multiline': 'true', ...(placeholder ? { 'data-placeholder': placeholder } : {}) } },
    onUpdate: ({ editor: e }) => onChange(e.getHTML(), editorText(e)),
  });

  useEffect(() => {
    onReady?.(editor);
    return () => onReady?.(null);
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`pm-rich${boxed ? ' pm-rich--boxed' : ''}`} style={{ ['--rich-font' as string]: font, ['--rich-size' as string]: size, ['--rich-min' as string]: minHeight ? `${minHeight}px` : undefined }}>
      {editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      link: e.isActive('link'),
    }),
  });
  const [linkOpen, setLinkOpen] = useState(false);
  const [url, setUrl] = useState('');

  const btn = (on: boolean, label: string, icon: typeof Bold, run: () => void, shortcut?: string) => (
    <button
      type="button"
      className={`pm-rich__btn${on ? ' pm-rich__btn--on' : ''}`}
      aria-pressed={on}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      // Il mousedown non deve togliere il focus (e la selezione) all'editor.
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      <Ic icon={icon} size={15} />
    </button>
  );

  const applyLink = () => {
    const href = url.trim();
    const chain = editor.chain().focus().extendMarkRange('link');
    if (href) chain.setLink({ href: /^[a-z]+:/i.test(href) ? href : `https://${href}` }).run();
    else chain.unsetLink().run();
    setLinkOpen(false);
    setUrl('');
  };

  return (
    <div className="pm-rich__bar" role="toolbar" aria-label="Formattazione">
      {btn(state.bold, 'Grassetto', Bold, () => editor.chain().focus().toggleBold().run(), '⌘B')}
      {btn(state.italic, 'Corsivo', Italic, () => editor.chain().focus().toggleItalic().run(), '⌘I')}
      {btn(state.underline, 'Sottolineato', Underline, () => editor.chain().focus().toggleUnderline().run(), '⌘U')}
      <span className="pm-rich__sep" aria-hidden="true" />
      {btn(state.bullet, 'Elenco puntato', List, () => editor.chain().focus().toggleBulletList().run())}
      {btn(state.ordered, 'Elenco numerato', ListOrdered, () => editor.chain().focus().toggleOrderedList().run())}
      <span className="pm-rich__sep" aria-hidden="true" />
      {btn(state.link || linkOpen, state.link ? 'Modifica o togli il link' : 'Inserisci link', Link2, () => {
        setUrl((editor.getAttributes('link').href as string | undefined) ?? '');
        setLinkOpen((v) => !v);
      })}
      {btn(false, 'Togli formattazione', RemoveFormatting, () => editor.chain().focus().unsetAllMarks().clearNodes().run())}
      {linkOpen && (
        <span className="pm-rich__link">
          <input
            className="pm-input"
            autoFocus
            value={url}
            placeholder="https://… (vuoto = togli il link)"
            aria-label="Indirizzo del link"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                applyLink();
              }
              if (e.key === 'Escape') {
                e.stopPropagation();
                setLinkOpen(false);
              }
            }}
          />
          <button type="button" className="pm-btn pm-btn--secondary pm-btn--xs" onClick={applyLink}>
            OK
          </button>
        </span>
      )}
    </div>
  );
}
