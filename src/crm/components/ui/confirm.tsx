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
 *   const name = await prompt({title: 'Name this view'}); // null when cancelled
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

export type PromptOptions = Omit<ConfirmOptions, 'destructive'> & {label?: string; placeholder?: string; defaultValue?: string};

type Request = {id: number} & (({kind: 'confirm'} & ConfirmOptions & {resolve: (v: boolean) => void}) | ({kind: 'prompt'} & PromptOptions & {resolve: (v: string | null) => void}));

let current: Request | null = null;
let seq = 0;
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
    <Dialog open={!!req} onOpenChange={(o) => !o && settle(null)}>
      {r && <ConfirmDrawer key={r.id} r={r} />}
    </Dialog>
  );
}

function ConfirmDrawer({r}: {r: Request}) {
  const [text, setText] = useState(r.kind === 'prompt' ? (r.defaultValue ?? '') : '');
  const value = text.trim();
  return (
    <DialogContent size="sm" role={r.kind === 'confirm' ? 'alertdialog' : 'dialog'} {...(!r.description && {'aria-describedby': undefined})}>
      <form noValidate onSubmit={(e) => (e.preventDefault(), e.stopPropagation(), settle(r.kind === 'confirm' ? true : value || null))} className="flex min-h-0 flex-1 flex-col">
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
            <Field label={r.label} htmlFor="prompt-input">
              <Input id="prompt-input" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={r.placeholder} aria-label={r.label ? undefined : r.title} />
            </Field>
          )}
          <div className="flex justify-end gap-2">
            {/* Destructive confirms focus Cancel, so Enter never deletes by accident. */}
            <Button type="button" variant="secondary" autoFocus={r.kind === 'confirm' && r.destructive} onClick={() => settle(r.kind === 'confirm' ? false : null)}>{r.cancelLabel ?? 'Cancel'}</Button>
            <Button type="submit" autoFocus={r.kind === 'confirm' && !r.destructive} variant={r.kind === 'confirm' && r.destructive ? 'destructive' : 'default'} disabled={r.kind === 'prompt' && !value}>
              {r.confirmLabel ?? (r.kind === 'prompt' ? 'Save' : 'OK')}
            </Button>
          </div>
        </DialogBody>
      </form>
    </DialogContent>
  );
}
