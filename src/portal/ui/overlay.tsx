import {
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {Button, IconButton} from './button';
import {Notice} from './display';
import {Icon, type IconName} from './icon';

/**
 * Dialogs, drawers, confirmations, toasts and menus. Dialogs are the native
 * `<dialog>` (`showModal()`): focus is trapped and returned, Esc closes, the
 * page behind is inert. Never `window.alert` / `window.confirm` in the portal:
 * use `useConfirm()` and `useToast()` (both mounted once by the shell).
 */

// ---------------------------------------------------------------- dialog --

function useDialog(open: boolean, onClose: () => void, dismissible: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // Esc: the browser closes the dialog unless we say no (a save is running).
    const cancel = (event: Event) => {
      event.preventDefault();
      if (dismissible) onClose();
    };
    dialog.addEventListener('cancel', cancel);
    return () => dialog.removeEventListener('cancel', cancel);
  }, [onClose, dismissible]);
  // A click on the backdrop (the dialog box itself, outside its content) closes it.
  const onClick = (event: React.MouseEvent<HTMLDialogElement>) => {
    if (dismissible && event.target === event.currentTarget) onClose();
  };
  return {ref, onClick};
}

type DialogProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** The buttons at the bottom: the primary action LAST (right). */
  footer?: ReactNode;
  /** False while an action runs: Esc, the backdrop and × do nothing. */
  dismissible?: boolean;
  size?: 'sm' | 'md' | 'lg';
};

/**
 * A centred dialog for a short task or a question (invite someone, rename,
 * confirm). Long forms and record details belong in a `Drawer`.
 */
export function Modal({open, onClose, title, description, children, footer, dismissible = true, size = 'md'}: DialogProps) {
  const {ref, onClick} = useDialog(open, onClose, dismissible);
  const id = useId();
  return (
    <dialog ref={ref} className={`modal modal-${size}`} aria-labelledby={`${id}-title`} onClick={onClick}>
      {open && (
        <div className="modal-box">
          <div className="modal-head">
            <div>
              <h2 id={`${id}-title`}>{title}</h2>
              {description && <p>{description}</p>}
            </div>
            <IconButton icon="x" label="Close" size="sm" onClick={onClose} disabled={!dismissible} />
          </div>
          {children && <div className="modal-body">{children}</div>}
          {footer && <div className="modal-foot">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

/**
 * A panel that slides in from the right: a create / edit form, a record's
 * details, a filter panel. Put the form's `<form>` around the WHOLE drawer
 * content (pass it as `as="form"` props) so the footer's submit button works.
 */
export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  dismissible = true,
  onSubmit,
}: DialogProps & {onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void}) {
  const {ref, onClick} = useDialog(open, onClose, dismissible);
  const id = useId();
  const content = (
    <>
      <div className="drawer-head">
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <IconButton icon="x" label="Close" size="sm" onClick={onClose} disabled={!dismissible} />
      </div>
      <div className="drawer-body">{children}</div>
      {footer && <div className="drawer-foot">{footer}</div>}
    </>
  );
  return (
    <dialog ref={ref} className="drawer" aria-labelledby={`${id}-title`} onClick={onClick}>
      {open &&
        (onSubmit ? (
          <form className="drawer-box" noValidate onSubmit={onSubmit}>
            {content}
          </form>
        ) : (
          <div className="drawer-box">{content}</div>
        ))}
    </dialog>
  );
}

// --------------------------------------------------------------- confirm --

type ConfirmOptions = {
  title: ReactNode;
  body?: ReactNode;
  /** The confirm button's label: the verb ("Delete job", "Suspend Sam"). */
  confirmLabel: string;
  /** While `action` runs ("Deleting…"). */
  pendingLabel?: string;
  /** `danger` (default) for destructive actions, `primary` for the rest. */
  tone?: 'danger' | 'primary';
  /**
   * The work itself. The dialog stays open with the button pending while it
   * runs; a failure shows in the dialog in words (try again or cancel).
   */
  action?: () => Promise<unknown>;
};

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

/**
 * `const confirm = useConfirm();` then
 * `await confirm({title: 'Delete this job?', confirmLabel: 'Delete job', action: () => remove.mutateAsync(id)})`.
 * Resolves `true` once the action succeeded (or confirmed, without one), `false` on cancel.
 */
export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm() needs <ConfirmProvider> (the portal shell mounts it).');
  return confirm;
}

export function ConfirmProvider({children}: {children: ReactNode}) {
  const [request, setRequest] = useState<(ConfirmOptions & {resolve: (ok: boolean) => void}) | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>(resolve => {
        setError(null);
        setPending(false);
        setRequest({...options, resolve});
      }),
    []
  );
  const close = useCallback(
    (ok: boolean) => {
      request?.resolve(ok);
      setRequest(null);
    },
    [request]
  );
  const run = async () => {
    if (!request) return;
    if (!request.action) return close(true);
    setPending(true);
    setError(null);
    try {
      await request.action();
      setPending(false);
      close(true);
    } catch (err) {
      setPending(false);
      setError(err instanceof Error ? err.message : 'That did not work. Try again.');
    }
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={request !== null}
        onClose={() => close(false)}
        dismissible={!pending}
        size="sm"
        title={request?.title}
        footer={
          <>
            <Button variant="secondary" onClick={() => close(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant={request?.tone ?? 'danger'} pending={pending} pendingLabel={request?.pendingLabel} onClick={() => void run()}>
              {request?.confirmLabel}
            </Button>
          </>
        }>
        {request?.body && <p className="modal-text">{request.body}</p>}
        {error && <Notice tone="danger">{error}</Notice>}
      </Modal>
    </ConfirmContext.Provider>
  );
}

// ----------------------------------------------------------------- toast --

type ToastTone = 'success' | 'info' | 'danger';
type ToastItem = {id: number; tone: ToastTone; message: string};
type Toaster = Record<ToastTone, (message: string) => void>;

const ToastContext = createContext<Toaster | null>(null);

/**
 * A short message after an action, at the bottom of the screen for 5 s:
 * `toast.success('Job posted.')`. For the result of a save that leaves the
 * screen (a drawer closed, a row removed). Errors that need fixing stay next
 * to the action instead (in the form, in the dialog).
 */
export function useToast() {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error('useToast() needs <ToastProvider> (the portal shell mounts it).');
  return toast;
}

export function ToastProvider({children}: {children: ReactNode}) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems(current => current.filter(item => item.id !== id)), []);
  const toaster = useMemo<Toaster>(() => {
    const push = (tone: ToastTone) => (message: string) => {
      const id = next.current++;
      setItems(current => [...current.slice(-2), {id, tone, message}]);
      window.setTimeout(() => dismiss(id), 5000);
    };
    return {success: push('success'), info: push('info'), danger: push('danger')};
  }, [dismiss]);
  const icons: Record<ToastTone, IconName> = {success: 'check-circle', info: 'info', danger: 'alert'};
  return (
    <ToastContext.Provider value={toaster}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map(item => (
          <div key={item.id} className={`toast toast-${item.tone}`}>
            <Icon name={icons[item.tone]} size={18} />
            <span>{item.message}</span>
            <IconButton icon="x" label="Dismiss" size="sm" onClick={() => dismiss(item.id)} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ------------------------------------------------------------------ menu --

export type MenuItem =
  | {label: string; icon?: IconName; onSelect: () => void; danger?: boolean; disabled?: boolean}
  | 'separator';

/**
 * A dropdown of actions: a row's "More" (⋯), the user menu. Keyboard: Enter /
 * Space / ↓ open it, ↑ ↓ move, Esc closes and returns focus. Put the row's
 * MAIN action on the row; the rest (and every destructive one) in here.
 *
 * Positioned `fixed` from the trigger, so a table's scroll box never clips it
 * (set through the CSSOM, which the CSP allows; never a `style=""` attribute).
 */
export function Menu({
  items,
  label,
  trigger,
  disabled,
  align = 'end',
}: {
  items: MenuItem[];
  /** What the menu is for ("Actions for Sam Rivera"): the trigger's label. */
  label: string;
  /** A custom trigger's content (the user menu's avatar); default ⋯. */
  trigger?: ReactNode;
  disabled?: boolean;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const actions = items.filter((item): item is Exclude<MenuItem, 'separator'> => item !== 'separator');

  const focusItem = (index: number) => {
    const nodes = list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    if (!nodes?.length) return;
    nodes[(index + nodes.length) % nodes.length]?.focus();
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open || !button.current || !list.current) return;
    const place = () => {
      const rect = button.current!.getBoundingClientRect();
      const menu = list.current!;
      const below = window.innerHeight - rect.bottom > menu.offsetHeight + 12;
      menu.style.top = `${below ? rect.bottom + 6 : rect.top - menu.offsetHeight - 6}px`;
      const left = align === 'end' ? rect.right - menu.offsetWidth : rect.left;
      menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - menu.offsetWidth - 8))}px`;
    };
    place();
    focusItem(0);
    const outside = (event: PointerEvent) => {
      if (!list.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) close(false);
    };
    const away = () => close(false);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', away);
    window.addEventListener('scroll', away, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', away);
      window.removeEventListener('scroll', away, true);
    };
  }, [open, align]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const nodes = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const at = nodes.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown') focusItem(at + 1);
    else if (event.key === 'ArrowUp') focusItem(at - 1);
    else if (event.key === 'Home') focusItem(0);
    else if (event.key === 'End') focusItem(nodes.length - 1);
    else if (event.key === 'Escape' || event.key === 'Tab') return close(event.key === 'Escape');
    else return;
    event.preventDefault();
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={trigger ? 'menu-trigger' : 'button button-ghost button-sm icon-button'}
        aria-label={label}
        title={trigger ? undefined : label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled || actions.length === 0}
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}>
        {trigger ?? <Icon name="more" size={16} />}
      </button>
      {open && (
        <div ref={list} id={id} className="menu" role="menu" aria-label={label} onKeyDown={onKeyDown}>
          {items.map((item, i) =>
            item === 'separator' ? (
              <div key={`s${i}`} className="menu-separator" role="separator" />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={item.danger ? 'menu-item menu-item-danger' : 'menu-item'}
                disabled={item.disabled}
                tabIndex={-1}
                onClick={() => {
                  close();
                  item.onSelect();
                }}>
                {item.icon && <Icon name={item.icon} size={16} />}
                {item.label}
              </button>
            )
          )}
        </div>
      )}
    </>
  );
}
