import type {ButtonHTMLAttributes, ReactNode} from 'react';

import {Icon, type IconName} from './icon';

/**
 * Buttons (AGENTS.md "Buttons and forms"): a button always shows when it is
 * busy and can never be pressed twice.
 *
 * | variant     | for                                                        |
 * | ----------- | ---------------------------------------------------------- |
 * | `primary`   | THE action of the screen or dialog. One per view.          |
 * | `secondary` | every other action (Cancel, Export, Load more)            |
 * | `ghost`     | quiet actions in toolbars, rows and cards                 |
 * | `link`      | an action that reads as a link inside text                |
 * | `danger`    | the confirm button of a destructive action (after a confirm) |
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'link' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

/** The classes of a button, for a `<Link>` or `<a>` that must look like one. */
export function buttonClass({variant = 'primary', size = 'md', block = false}: {variant?: ButtonVariant; size?: ButtonSize; block?: boolean} = {}) {
  return ['button', `button-${variant}`, size === 'md' ? '' : `button-${size}`, block ? 'button-block' : ''].filter(Boolean).join(' ');
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** An icon before the label. */
  icon?: IconName;
  /** An icon after the label (a chevron, an arrow). */
  iconEnd?: IconName;
  /** Full width (forms on a phone, a dialog's only action). */
  block?: boolean;
  /** The action is running: spinner, `aria-busy`, and the button cannot be pressed. */
  pending?: boolean;
  /** What the button says while pending ("Saving…"). Defaults to its label. */
  pendingLabel?: ReactNode;
};

/**
 * `type="button"` unless you say `submit`, so a button inside a form never
 * submits it by accident. Disabled while `pending` OR `disabled`. Labels are
 * short verbs ("Save", "Invite people").
 */
export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  iconEnd,
  block,
  pending = false,
  pendingLabel,
  disabled,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  const iconSize = size === 'sm' ? 16 : 18;
  return (
    <button
      {...rest}
      type={type}
      className={[buttonClass({variant, size, block}), className].filter(Boolean).join(' ')}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      aria-disabled={disabled || pending || undefined}>
      {pending ? <span className="spinner" aria-hidden="true" /> : icon && <Icon name={icon} size={iconSize} />}
      {pending ? (pendingLabel ?? children) : children}
      {!pending && iconEnd && <Icon name={iconEnd} size={iconSize} />}
    </button>
  );
}

/**
 * A button that is only an icon. `label` is REQUIRED: it is what a screen
 * reader says and the tooltip a mouse user sees.
 */
export function IconButton({
  icon,
  label,
  variant = 'ghost',
  size = 'md',
  pending = false,
  disabled,
  type = 'button',
  className,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: IconName;
  label: string;
  variant?: Exclude<ButtonVariant, 'link'>;
  size?: ButtonSize;
  pending?: boolean;
}) {
  return (
    <button
      {...rest}
      type={type}
      className={[buttonClass({variant, size}), 'icon-button', className].filter(Boolean).join(' ')}
      aria-label={label}
      title={label}
      disabled={disabled || pending}
      aria-busy={pending || undefined}>
      {pending ? <span className="spinner" aria-hidden="true" /> : <Icon name={icon} size={size === 'sm' ? 16 : 18} />}
    </button>
  );
}
