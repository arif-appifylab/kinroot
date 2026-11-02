/**
 * The rich-text email editor (TipTap). Loaded lazily through ./index.tsx so
 * pages without an editor don't pay for it. Output is plain semantic HTML
 * plus two custom elements (merge-field chips and CTA buttons) that
 * `toEmailHtml()` turns into email-safe markup.
 */
import {mergeAttributes, Node} from '@tiptap/core';
import Image from '@tiptap/extension-image';
import TextAlign from '@tiptap/extension-text-align';
import {Placeholder} from '@tiptap/extensions';
import {EditorContent, useEditor, useEditorState, type Editor} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AtSign,
  Bold,
  Braces,
  Heading1,
  Heading2,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Loader2,
  Minus,
  MousePointerClick,
  Pilcrow,
  Quote,
  Redo2,
  Strikethrough,
  Underline,
  Undo2,
} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';
import {toast} from 'sonner';

import {Button} from '@/components/ui/button';
import {Field, Input} from '@/components/ui/form';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Popover, PopoverAnchor, PopoverContent} from '@/components/ui/menu';
import {MERGE_FIELDS, mergeLabel} from '@/lib/email-html';
import {cn} from '@/lib/utils';

import {uploadEmailImage} from './upload';

// ─── Custom nodes ───

/** {{contact.first_name|there}} as an inline chip. */
const MergeField = Node.create({
  name: 'mergeField',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      key: {default: 'contact.first_name', parseHTML: (el) => el.getAttribute('data-merge'), renderHTML: (a) => ({'data-merge': a.key})},
      fallback: {default: '', parseHTML: (el) => el.getAttribute('data-fallback') ?? '', renderHTML: (a) => (a.fallback ? {'data-fallback': a.fallback} : {})},
    };
  },
  parseHTML: () => [{tag: 'span[data-merge]'}],
  renderHTML: ({node, HTMLAttributes}) => ['span', mergeAttributes(HTMLAttributes, {class: 'merge-chip', contenteditable: 'false'}), mergeLabel(node.attrs.key as string)],
  renderText: ({node}) => `{{${node.attrs.key}${node.attrs.fallback ? `|${node.attrs.fallback}` : ''}}}`,
});

/** Call-to-action button block. */
const EmailButton = Node.create({
  name: 'emailButton',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      href: {default: 'https://', parseHTML: (el) => el.getAttribute('data-href'), renderHTML: (a) => ({'data-href': a.href})},
      label: {default: 'Learn more', parseHTML: (el) => el.textContent?.trim() || 'Learn more', renderHTML: () => ({})},
      align: {default: 'left', parseHTML: (el) => el.getAttribute('data-align') ?? 'left', renderHTML: (a) => ({'data-align': a.align})},
    };
  },
  parseHTML: () => [{tag: 'div[data-type="button"]'}],
  renderHTML: ({node, HTMLAttributes}) => ['div', mergeAttributes(HTMLAttributes, {'data-type': 'button', class: 'email-btn'}), node.attrs.label as string],
});

/** Images keep a width (resize handles or the size buttons) and an alignment. */
const EmailImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      'data-align': {default: 'left'},
    };
  },
}).configure({resize: {enabled: true, minWidth: 40, alwaysPreserveAspectRatio: true}});

// ─── Toolbar ───

function ToolButton({active, label, onClick, children, disabled}: {active?: boolean; label: string; onClick: () => void; children: React.ReactNode; disabled?: boolean}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // keep the editor selection
      onClick={onClick}
      className={cn(
        'inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:size-4',
        active && 'bg-accent text-primary hover:bg-accent hover:text-primary',
      )}
    >
      {children}
    </button>
  );
}

const Sep = () => <span className="mx-0.5 h-5 w-px shrink-0 bg-slate-200" />;

function LinkPopover({editor, open, onOpenChange}: {editor: Editor; open: boolean; onOpenChange: (o: boolean) => void}) {
  const [href, setHref] = useState('');
  useEffect(() => {
    if (open) setHref((editor.getAttributes('link').href as string) ?? 'https://');
  }, [open, editor]);
  const apply = () => {
    const url = href.trim();
    if (!url || url === 'https://') editor.chain().focus().extendMarkRange('link').unsetLink().run();
    else if (editor.state.selection.empty && !editor.isActive('link')) editor.chain().focus().insertContent({type: 'text', text: url, marks: [{type: 'link', attrs: {href: url}}]}).run();
    else editor.chain().focus().extendMarkRange('link').setLink({href: url}).run();
    onOpenChange(false);
  };
  return (
    <PopoverContent className="w-80 p-3" onOpenAutoFocus={(e) => e.preventDefault()}>
      <form onSubmit={(e) => (e.preventDefault(), apply())} className="grid gap-2">
        <Field label="Link address" htmlFor="ed-link">
          <Input id="ed-link" autoFocus value={href} onChange={(e) => setHref(e.target.value)} placeholder="https://… or {{unsubscribe_url}}" />
        </Field>
        <div className="flex justify-end gap-2">
          {editor.isActive('link') && (
            <Button type="button" variant="ghost" size="sm" onClick={() => (editor.chain().focus().extendMarkRange('link').unsetLink().run(), onOpenChange(false))}>
              Remove
            </Button>
          )}
          <Button type="submit" size="sm">Apply</Button>
        </div>
      </form>
    </PopoverContent>
  );
}

function ButtonPopover({editor, onDone}: {editor: Editor; onDone: () => void}) {
  const editing = editor.isActive('emailButton');
  const current = editing ? editor.getAttributes('emailButton') : {label: 'Book a call', href: 'https://', align: 'left'};
  const [form, setForm] = useState({label: String(current.label), href: String(current.href), align: String(current.align)});
  const apply = () => {
    if (editing) editor.chain().focus().updateAttributes('emailButton', form).run();
    else editor.chain().focus().insertContent({type: 'emailButton', attrs: form}).run();
    onDone();
  };
  return (
    <PopoverContent className="w-80 p-3" onOpenAutoFocus={(e) => e.preventDefault()}>
      <form onSubmit={(e) => (e.preventDefault(), apply())} className="grid gap-2.5">
        <Field label="Button text" htmlFor="ed-btn-label"><Input id="ed-btn-label" autoFocus required value={form.label} onChange={(e) => setForm({...form, label: e.target.value})} /></Field>
        <Field label="Link" htmlFor="ed-btn-href"><Input id="ed-btn-href" required value={form.href} onChange={(e) => setForm({...form, href: e.target.value})} placeholder="https://" /></Field>
        <div className="flex items-center gap-1">
          {(['left', 'center'] as const).map((a) => (
            <Button key={a} type="button" variant={form.align === a ? 'soft' : 'ghost'} size="sm" onClick={() => setForm({...form, align: a})}>
              {a === 'left' ? <AlignLeft /> : <AlignCenter />} {a === 'left' ? 'Left' : 'Centre'}
            </Button>
          ))}
          <Button type="submit" size="sm" className="ml-auto">{editing ? 'Update' : 'Insert'}</Button>
        </div>
      </form>
    </PopoverContent>
  );
}

type ToolbarProps = {editor: Editor; images: boolean; headings: boolean; text: boolean; mergeFields: boolean; mentions?: {id: string; name: string}[]};

function Toolbar({editor, images, headings, text, mergeFields, mentions}: ToolbarProps) {
  const s = useEditorState({
    editor,
    selector: ({editor: e}) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      h1: e.isActive('heading', {level: 1}),
      h2: e.isActive('heading', {level: 2}),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      link: e.isActive('link'),
      quote: e.isActive('blockquote'),
      button: e.isActive('emailButton'),
      image: e.isActive('image'),
      imageWidth: e.isActive('image') ? (e.getAttributes('image').width as number | null) : null,
      center: e.isActive({textAlign: 'center'}),
      right: e.isActive({textAlign: 'right'}),
      undo: e.can().undo(),
      redo: e.can().redo(),
    }),
  });
  const [linkOpen, setLinkOpen] = useState(false);
  const [buttonOpen, setButtonOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const chain = () => editor.chain().focus();

  const onFile = async (file?: File) => {
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadEmailImage(file);
      chain().setImage({src: url, alt: file.name.replace(/\.[a-z]+$/i, '')}).run();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-slate-100 bg-slate-50/70 px-1.5 py-1">
      {headings && (
        <>
          <ToolButton label="Paragraph" active={!s.h1 && !s.h2} onClick={() => chain().setParagraph().run()}><Pilcrow /></ToolButton>
          <ToolButton label="Large heading" active={s.h1} onClick={() => chain().toggleHeading({level: 1}).run()}><Heading1 /></ToolButton>
          <ToolButton label="Heading" active={s.h2} onClick={() => chain().toggleHeading({level: 2}).run()}><Heading2 /></ToolButton>
          <Sep />
        </>
      )}
      <ToolButton label="Bold" active={s.bold} onClick={() => chain().toggleBold().run()}><Bold /></ToolButton>
      <ToolButton label="Italic" active={s.italic} onClick={() => chain().toggleItalic().run()}><Italic /></ToolButton>
      <ToolButton label="Underline" active={s.underline} onClick={() => chain().toggleUnderline().run()}><Underline /></ToolButton>
      <ToolButton label="Strikethrough" active={s.strike} onClick={() => chain().toggleStrike().run()}><Strikethrough /></ToolButton>
      <Popover open={linkOpen} onOpenChange={setLinkOpen}>
        <PopoverAnchor asChild>
          <span><ToolButton label="Link" active={s.link} onClick={() => setLinkOpen(true)}><Link2 /></ToolButton></span>
        </PopoverAnchor>
        <LinkPopover editor={editor} open={linkOpen} onOpenChange={setLinkOpen} />
      </Popover>
      <Sep />
      <ToolButton label="Bulleted list" active={s.bullet} onClick={() => chain().toggleBulletList().run()}><List /></ToolButton>
      <ToolButton label="Numbered list" active={s.ordered} onClick={() => chain().toggleOrderedList().run()}><ListOrdered /></ToolButton>
      {text ? (
        <ToolButton label="Quote" active={s.quote} onClick={() => chain().toggleBlockquote().run()}><Quote /></ToolButton>
      ) : (
        <>
          <ToolButton label="Align left" active={!s.center && !s.right} onClick={() => chain().setTextAlign('left').run()}><AlignLeft /></ToolButton>
          <ToolButton label="Align centre" active={s.center} onClick={() => chain().setTextAlign('center').run()}><AlignCenter /></ToolButton>
          <ToolButton label="Align right" active={s.right} onClick={() => chain().setTextAlign('right').run()}><AlignRight /></ToolButton>
        </>
      )}
      {(!text || mergeFields || !!mentions?.length) && <Sep />}
      {!text && images && (
        <>
          <ToolButton label="Insert image" disabled={uploading} onClick={() => fileRef.current?.click()}>{uploading ? <Loader2 className="animate-spin" /> : <ImagePlus />}</ToolButton>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        </>
      )}
      {!text && (
        <>
          <Popover open={buttonOpen} onOpenChange={setButtonOpen}>
            <PopoverAnchor asChild>
              <span><ToolButton label={s.button ? 'Edit button' : 'Insert button'} active={s.button} onClick={() => setButtonOpen(true)}><MousePointerClick /></ToolButton></span>
            </PopoverAnchor>
            {buttonOpen && <ButtonPopover editor={editor} onDone={() => setButtonOpen(false)} />}
          </Popover>
          <ToolButton label="Divider" onClick={() => chain().setHorizontalRule().run()}><Minus /></ToolButton>
        </>
      )}
      {!!mentions?.length && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" onMouseDown={(e) => e.preventDefault()} className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 hover:text-slate-900">
              <AtSign className="size-4" /> Mention
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
            {/* Inserted as "@Full Name": notifyMentions() finds it in the note's plain text. */}
            {mentions.map((m) => (
              <DropdownMenuItem key={m.id} onSelect={() => chain().insertContent([{type: 'text', text: `@${m.name}`, marks: [{type: 'bold'}]}, {type: 'text', text: ' '}]).run()}>
                {m.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {mergeFields && <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" onMouseDown={(e) => e.preventDefault()} className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 hover:text-slate-900">
            <Braces className="size-4" /> Merge field
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
          {MERGE_FIELDS.map((f) => (
            <DropdownMenuItem
              key={f.key}
              onSelect={() => {
                if (f.key === 'unsubscribe_url') chain().insertContent({type: 'text', text: 'Unsubscribe', marks: [{type: 'link', attrs: {href: '{{unsubscribe_url}}'}}]}).run();
                else chain().insertContent([{type: 'mergeField', attrs: {key: f.key, fallback: f.key === 'contact.first_name' ? 'there' : ''}}, {type: 'text', text: ' '}]).run();
              }}
            >
              {f.label} <span className="ml-auto pl-3 font-mono text-[11px] text-slate-400">{f.key}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>}
      <span className="ml-auto flex items-center">
        <ToolButton label="Undo" disabled={!s.undo} onClick={() => chain().undo().run()}><Undo2 /></ToolButton>
        <ToolButton label="Redo" disabled={!s.redo} onClick={() => chain().redo().run()}><Redo2 /></ToolButton>
      </span>
      {s.image && (
        <div className="flex w-full flex-wrap items-center gap-1 border-t border-slate-100 pt-1 text-xs font-semibold text-slate-500">
          <span className="px-1.5">Image size</span>
          {[
            ['S', 120],
            ['M', 240],
            ['L', 400],
            ['Full', 600],
          ].map(([label, w]) => (
            <Button key={label} type="button" size="sm" variant={s.imageWidth === w ? 'soft' : 'ghost'} className="h-7 px-2" onMouseDown={(e) => e.preventDefault()} onClick={() => chain().updateAttributes('image', {width: w}).run()}>
              {label}
            </Button>
          ))}
          <span className="px-1.5">Align</span>
          {(['left', 'center', 'right'] as const).map((a) => (
            <ToolButton key={a} label={`Image ${a}`} onClick={() => chain().updateAttributes('image', {'data-align': a}).run()}>
              {a === 'left' ? <AlignLeft /> : a === 'center' ? <AlignCenter /> : <AlignRight />}
            </ToolButton>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Editor ───

export type RichEditorProps = {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  /** Smaller toolbar and height (composer, signatures). */
  compact?: boolean;
  /** Image upload button (needs the public file route). Default true. */
  images?: boolean;
  /** Heading buttons. Default true. */
  headings?: boolean;
  minHeight?: number;
  className?: string;
  ariaLabel?: string;
  /**
   * 'email' (default): the full email toolbar. 'text': formatting for messages people read
   * in the app or the support portal (tickets): bold, italic, underline, strike, links, lists,
   * quotes; no headings, alignment, images, buttons or dividers.
   */
  variant?: 'email' | 'text';
  /** Merge-field menu. Default: on for 'email', off for 'text'. */
  mergeFields?: boolean;
  /** Team members for a Mention menu that inserts "@Full Name" (internal notes). */
  mentions?: {id: string; name: string}[];
  /** Cmd / Ctrl + Enter. */
  onSubmit?: () => void;
};

export default function RichEditor({value, onChange, placeholder, compact, images = true, headings = true, minHeight, className, ariaLabel = 'Message', variant = 'email', mergeFields, mentions, onSubmit}: RichEditorProps) {
  const last = useRef(value);
  const submit = useRef(onSubmit);
  submit.current = onSubmit;
  const text = variant === 'text';
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({heading: {levels: [1, 2, 3]}, code: false, codeBlock: false, link: {openOnClick: false, autolink: true, defaultProtocol: 'https'}}),
      TextAlign.configure({types: ['heading', 'paragraph']}),
      Placeholder.configure({placeholder: placeholder ?? 'Write your message…'}),
      EmailImage,
      MergeField,
      EmailButton,
    ],
    content: value,
    editorProps: {
      attributes: {'aria-label': ariaLabel, role: 'textbox', 'aria-multiline': 'true'},
      handleKeyDown: (_view, e) => {
        if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter' || !submit.current) return false;
        e.preventDefault();
        submit.current();
        return true;
      },
    },
    onUpdate: ({editor: e}) => {
      const html = e.isEmpty ? '' : e.getHTML();
      last.current = html;
      onChange(html);
    },
  });

  // Outside changes (a template was inserted, the form reset) replace the content.
  useEffect(() => {
    if (editor && value !== last.current) {
      last.current = value;
      editor.commands.setContent(value || '', {emitUpdate: false});
    }
  }, [value, editor]);

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-input bg-card shadow-xs transition-[box-shadow,border-color] focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25',
        className,
      )}
    >
      {editor ? (
        <Toolbar editor={editor} images={images} headings={headings && !compact && !text} text={text} mergeFields={mergeFields ?? !text} mentions={mentions} />
      ) : (
        <div className="h-10 border-b border-slate-100 bg-slate-50/70" />
      )}
      <EditorContent
        editor={editor}
        style={{minHeight: minHeight ?? (compact ? 140 : 260)}}
        className={cn(
          'cursor-text px-4 py-3 text-[15px] leading-relaxed text-slate-800',
          '[&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-[inherit]',
          '[&_.ProseMirror_p]:my-0 [&_.ProseMirror_p+p]:mt-3 [&_.ProseMirror_h1]:mt-2 [&_.ProseMirror_h1]:mb-3 [&_.ProseMirror_h1]:text-2xl [&_.ProseMirror_h1]:font-extrabold [&_.ProseMirror_h2]:mt-4 [&_.ProseMirror_h2]:mb-2 [&_.ProseMirror_h2]:text-xl [&_.ProseMirror_h2]:font-bold [&_.ProseMirror_h3]:font-bold',
          '[&_.ProseMirror_ul]:my-3 [&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:pl-6 [&_.ProseMirror_ol]:my-3 [&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-6 [&_.ProseMirror_li_p]:my-0',
          '[&_.ProseMirror_a]:text-primary [&_.ProseMirror_a]:underline [&_.ProseMirror_hr]:my-5 [&_.ProseMirror_hr]:border-slate-200 [&_.ProseMirror_blockquote]:border-l-2 [&_.ProseMirror_blockquote]:border-slate-300 [&_.ProseMirror_blockquote]:pl-3 [&_.ProseMirror_blockquote]:text-slate-600',
          '[&_.ProseMirror_img]:my-3 [&_.ProseMirror_img]:max-w-full [&_.ProseMirror_img]:rounded-md [&_.ProseMirror-selectednode]:outline-2 [&_.ProseMirror-selectednode]:outline-primary [&_[data-align=center]>img]:mx-auto [&_img[data-align=center]]:mx-auto [&_img[data-align=right]]:ml-auto',
          '[&_.merge-chip]:mx-0.5 [&_.merge-chip]:inline-flex [&_.merge-chip]:items-center [&_.merge-chip]:rounded-md [&_.merge-chip]:bg-accent [&_.merge-chip]:px-1.5 [&_.merge-chip]:py-px [&_.merge-chip]:text-[13px] [&_.merge-chip]:font-semibold [&_.merge-chip]:text-primary',
          '[&_.email-btn]:my-3 [&_.email-btn]:w-fit [&_.email-btn]:cursor-pointer [&_.email-btn]:rounded-lg [&_.email-btn]:bg-brand [&_.email-btn]:px-5 [&_.email-btn]:py-2.5 [&_.email-btn]:text-sm [&_.email-btn]:font-semibold [&_.email-btn]:text-white [&_.email-btn[data-align=center]]:mx-auto',
          '[&_.is-editor-empty:first-child]:before:pointer-events-none [&_.is-editor-empty:first-child]:before:float-left [&_.is-editor-empty:first-child]:before:h-0 [&_.is-editor-empty:first-child]:before:text-slate-400 [&_.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]',
        )}
      />
    </div>
  );
}
