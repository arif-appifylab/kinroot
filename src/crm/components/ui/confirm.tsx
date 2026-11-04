import {AlertTriangle} from 'lucide-react';
import {useRef, useState, useSyncExternalStore, type ReactNode} from 'react';

import {Button} from './button';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle} from './dialog';
import {Field, Input} from './form';

/**
 * In-app replacements for `window.confirm()` / `window.prompt()`, shown as a
 * small drawer. Promise-based so call sites stay one-liners:
 *
 *   onSelect={async () => (await confirm({title: `Delete ${name}?`, destructive: true})) && remove.mutate(undefined)}
 *   const name = await prompt({title: 'Name this view', maxLength: 60}); // null when cancelled
 *
 * A prompt checks its value before it closes (`required`, `maxLength`, `rules`: the same limits as
 * the server) and shows what is wrong under the input; with `action` it stays open, pending, until
 * the save answers, and shows a refusal under the input instead of losing what was typed.
 *
 * `<ConfirmHost />` is mounted once in the root route, so this works on signed-in
 * and public pages, and from inside another drawer.
 */
export type ConfirmOptions = {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button, for deletes and other actions that lose data. */
  destructive?: boolean;
};

export type PromptOptions = Omit<ConfirmOptions, 'destructive'> & {
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  /** Words shown when it is left empty (an empty prompt never resolves). */
  required?: string;
  /** The server's length limit: typing stops there and a longer pasted value is refused in words. */
  maxLength?: number;
  /** More checks on the trimmed value: return the words that say how to fix it, or nothing. */
  rules?: ((value: string) => string | null | undefined | false)[];
  inputMode?: 'text' | 'numeric' | 'decimal' | 'email' | 'url';
  /** Runs with the value while the dialog stays open (button pending); a throw shows its message under the input. */
  action?: (value: string) => Promise<unknown>;
};

type Request = {id: number} & (({kind: 'confirm'} & ConfirmOptions & {resolve: (v: boolean) => void}) | ({kind: 'prompt'} & PromptOptions & {resolve: (v: string | null) => void}));

let current: Request | null = null;
let seq = 0;
/** A prompt's `action` is running: the dialog can't be dismissed until it answers. */
let busy = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function open(req: Request) {
  // Next tick: a dropdown menu that triggered this closes (and returns focus) first.
  setTimeout(() => {
    // One at a time, like the native dialogs: a newer request cancels the one showing.
    if (current) settle(null);
    current = req;
    emit();
  });
}

function settle(value: boolean | string | null) {
  const req = current;
  if (!req) return;
  current = null;
  emit();
  if (req.kind === 'confirm') req.resolve(value === true);
  else req.resolve(typeof value === 'string' ? value : null);
}

/** Resolves `true` when the user confirms, `false` when they cancel or dismiss. */
export function confirm(options: ConfirmOptions | string): Promise<boolean> {
  const opts = typeof options === 'string' ? {title: options} : options;
  return new Promise((resolve) => open({id: ++seq, kind: 'confirm', ...opts, resolve}));
}

/** Resolves the trimmed text, or `null` when cancelled or left empty. */
export function prompt(options: PromptOptions | string): Promise<string | null> {
  const opts = typeof options === 'string' ? {title: options} : options;
  return new Promise((resolve) => open({id: ++seq, kind: 'prompt', ...opts, resolve}));
}

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

export function ConfirmHost() {
  const req = useSyncExternalStore(subscribe, () => current, () => null);
  // Keep the last request rendered while the drawer animates out.
  const last = useRef(req);
  if (req) last.current = req;
  const r = req ?? last.current;
  return (
    <Dialog open={!!req} onOpenChange={(o) => !o && !busy && settle(null)}>
      {r && <ConfirmDrawer key={r.id} r={r} />}
    </Dialog>
  );
}

function promptError(r: PromptOptions, value: string): string | undefined {
  if (!value) return r.required ?? 'Enter a value.';
  if (r.maxLength && value.length > r.maxLength) return `Use at most ${r.maxLength} characters.`;
  for (const rule of r.rules ?? []) {
    const message = rule(value);
    if (message) return message;
  }
  return undefined;
}

function ConfirmDrawer({r}: {r: Request}) {
  const [text, setText] = useState(r.kind === 'prompt' ? (r.defaultValue ?? '') : '');
  // A prompt's error shows after a submit (or leaving the field), then live while typing.
  const [shown, setShown] = useState(false);
  const [pending, setPending] = useState(false);
  const [refused, setRefused] = useState<{message: string; at: string} | null>(null);
  const value = text.trim();
  const local = r.kind === 'prompt' ? promptError(r, value) : undefined;
  const error = (refused && refused.at === text ? refused.message : undefined) ?? (shown ? local : undefined);

  const submit = async () => {
    if (r.kind === 'confirm') return settle(true);
    setShown(true);
    if (local || pending) return;
    if (!r.action) return settle(value);
    setPending(true);
    busy = true;
    try {
      await r.action(value);
      busy = false;
      settle(value);
    } catch (e) {
      setRefused({message: e instanceof Error && e.message ? e.message : 'That did not save. Try again.', at: text});
    } finally {
      busy = false;
      setPending(false);
    }
  };

  return (
    <DialogContent size="sm" role={r.kind === 'confirm' ? 'alertdialog' : 'dialog'} {...(!r.description && {'aria-describedby': undefined})}>
      <form noValidate onSubmit={(e) => (e.preventDefault(), e.stopPropagation(), void submit())} className="flex min-h-0 flex-1 flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-start gap-2.5">
            {r.kind === 'confirm' && r.destructive && <AlertTriangle className="mt-1 size-4 shrink-0 text-destructive" />}
            <span>{r.title}</span>
          </DialogTitle>
          {r.description && <DialogDescription>{r.description}</DialogDescription>}
        </DialogHeader>
        {/* Actions sit right under the question: a short confirm shouldn't make the eye travel to the bottom of a full-height drawer. */}
        <DialogBody className="grid content-start gap-5">
          {r.kind === 'prompt' && (
            <Field label={r.label} htmlFor="prompt-input" error={error}>
              <Input
                id="prompt-input"
                autoFocus
                value={text}
                maxLength={r.maxLength}
                inputMode={r.inputMode}
                readOnly={pending}
                onChange={(e) => setText(e.target.value)}
                onBlur={() => value && setShown(true)}
                placeholder={r.placeholder}
                aria-label={r.label ? undefined : r.title}
              />
            </Field>
          )}
          <div className="flex justify-end gap-2">
            {/* Destructive confirms focus Cancel, so Enter never deletes by accident. */}
            <Button type="button" variant="secondary" disabled={pending} autoFocus={r.kind === 'confirm' && r.destructive} onClick={() => settle(r.kind === 'confirm' ? false : null)}>{r.cancelLabel ?? 'Cancel'}</Button>
            <Button type="submit" pending={pending} pendingLabel="Saving…" autoFocus={r.kind === 'confirm' && !r.destructive} variant={r.kind === 'confirm' && r.destructive ? 'destructive' : 'default'}>
              {r.confirmLabel ?? (r.kind === 'prompt' ? 'Save' : 'OK')}
            </Button>
          </div>
        </DialogBody>
      </form>
    </DialogContent>
  );
}
