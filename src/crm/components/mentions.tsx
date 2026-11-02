import {Fragment, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent} from 'react';

import {useTeam} from '@/lib/queries';
import {cn} from '@/lib/utils';

import {Input, Textarea} from './ui/form';
import {Avatar} from './ui/misc';

/** "@", then up to two words typed right before the caret. */
const TRIGGER = /(?:^|\s)@([^\s@]{0,30}(?: [^\s@]{0,30})?)$/;

type Common = {value: string; onChange: (value: string) => void};
type Props =
  | (Common & {as?: 'textarea'} & Omit<ComponentProps<'textarea'>, 'value' | 'onChange'>)
  | (Common & {as: 'input'} & Omit<ComponentProps<'input'>, 'value' | 'onChange'>);

/**
 * Textarea / input with an @mention picker. Picking a teammate inserts
 * "@Full Name", which the server turns into a mention notification.
 */
export function MentionField({value, onChange, as = 'textarea', onKeyDown, className, ...rest}: Props) {
  const team = useTeam();
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const matches = useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    return (team.data ?? [])
      .filter((u) => u.active && (u.name.toLowerCase().startsWith(q) || u.name.toLowerCase().split(' ').some((w) => w.startsWith(q))))
      .slice(0, 6);
  }, [query, team.data]);

  function detect(el: HTMLTextAreaElement | HTMLInputElement) {
    const m = el.value.slice(0, el.selectionStart ?? el.value.length).match(TRIGGER);
    setQuery(m ? m[1]! : null);
    setActive(0);
  }

  function pick(name: string) {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart ?? value.length;
    const before = value.slice(0, caret).replace(/@([^\s@]{0,30}(?: [^\s@]{0,30})?)$/, `@${name} `);
    const next = before + value.slice(caret);
    onChange(next);
    setQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  }

  function keyDown(e: KeyboardEvent<HTMLTextAreaElement & HTMLInputElement>) {
    if (matches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(matches[active]!.name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setQuery(null);
        return;
      }
    }
    (onKeyDown as ((e: KeyboardEvent<HTMLTextAreaElement & HTMLInputElement>) => void) | undefined)?.(e);
  }

  const shared = {
    ref,
    value,
    className,
    onChange: (e: {target: HTMLTextAreaElement | HTMLInputElement}) => (onChange(e.target.value), detect(e.target)),
    onKeyDown: keyDown,
    onClick: (e: {currentTarget: HTMLTextAreaElement | HTMLInputElement}) => detect(e.currentTarget),
    onBlur: () => setTimeout(() => setQuery(null), 150),
    'aria-autocomplete': 'list' as const,
    'aria-expanded': matches.length > 0,
  };

  return (
    <div className="relative min-w-0 flex-1">
      {as === 'input' ? <Input {...(rest as Omit<ComponentProps<'input'>, 'size'>)} {...shared} /> : <Textarea {...(rest as ComponentProps<'textarea'>)} {...shared} />}
      {matches.length > 0 && (
        <ul role="listbox" className="absolute top-full left-0 z-50 mt-1 w-64 overflow-hidden rounded-xl border border-slate-200 bg-popover p-1 shadow-lift animate-in fade-in-0 zoom-in-95">
          {matches.map((u, i) => (
            <li key={u.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => (e.preventDefault(), pick(u.name))}
                onMouseEnter={() => setActive(i)}
                className={cn('flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm', i === active ? 'bg-primary/10 text-slate-900' : 'text-slate-700')}
              >
                <Avatar name={u.name} color={u.color} src={u.avatarUrl} size="xs" className="ring-0" />
                <span className="min-w-0 flex-1 truncate font-medium">{u.name}</span>
                <span className="truncate text-xs text-muted-foreground">{u.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Text with teammates' "@Full Name" mentions highlighted. */
export function MentionText({text}: {text: string}) {
  const team = useTeam();
  const pattern = useMemo(() => {
    const names = (team.data ?? []).map((u) => u.name).filter(Boolean).sort((a, b) => b.length - a.length);
    if (!names.length) return null;
    return new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}))(?![\\p{L}\\p{N}])`, 'giu');
  }, [team.data]);
  if (!pattern || !text.includes('@')) return <>{text}</>;
  return (
    <>
      {text.split(pattern).map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="rounded bg-primary/10 px-0.5 font-semibold text-primary">{part}</span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
