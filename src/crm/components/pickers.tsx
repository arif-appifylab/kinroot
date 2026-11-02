import {useQuery, useQueryClient} from '@tanstack/react-query';
import {Command} from 'cmdk';
import {Building2, Check, ChevronsUpDown, Plus, Tag, User, X} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';
import {toast} from 'sonner';

import {api} from '@/lib/api';
import {fullName} from '@/lib/format';
import {keys, useTeam} from '@/lib/queries';
import type {CompanyLite, ContactLite, EntityType, Paged} from '@/lib/types';
import {cn} from '@/lib/utils';

import {NativeSelect} from './ui/form';
import {Popover, PopoverAnchor, PopoverContent, PopoverTrigger} from './ui/menu';
import {Avatar} from './ui/misc';

const trigger =
  'flex h-10 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-input bg-card px-3 text-left text-sm shadow-xs transition-all outline-none hover:border-slate-300 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25';

export function UserSelect({value, onChange, allowNone = true, id}: {value: string | null | undefined; onChange: (v: string | null) => void; allowNone?: boolean; id?: string}) {
  const team = useTeam();
  return (
    <NativeSelect id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      {allowNone && <option value="">Unassigned</option>}
      {team.data?.filter((u) => u.active || u.id === value).map((u) => (
        <option key={u.id} value={u.id}>{u.name}</option>
      ))}
    </NativeSelect>
  );
}

function SearchList({placeholder, search, onSearch, children, loading}: {placeholder: string; search: string; onSearch: (v: string) => void; children: React.ReactNode; loading?: boolean}) {
  return (
    <Command shouldFilter={false} className="flex flex-col">
      <Command.Input
        value={search}
        onValueChange={onSearch}
        placeholder={placeholder}
        className="h-11 border-b border-slate-100 px-3 text-sm outline-none placeholder:text-slate-400"
      />
      <Command.List className="max-h-64 overflow-y-auto p-1 scrollbar-thin">
        {loading && <Command.Loading><p className="px-3 py-2 text-sm text-muted-foreground">Searching…</p></Command.Loading>}
        <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">No matches</Command.Empty>
        {children}
      </Command.List>
    </Command>
  );
}

const itemCls = 'flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-slate-700 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground';

/** The "add it directly" row at the bottom of every picker. */
function CreateItem({label, onSelect}: {label: string; onSelect: () => void}) {
  return (
    <Command.Item value="__create" onSelect={onSelect} className={cn(itemCls, 'mt-1 border-t border-slate-100 pt-2.5 font-semibold text-primary data-[selected=true]:text-primary')}>
      <span className="flex size-5 items-center justify-center rounded-md bg-brand text-white"><Plus className="size-3.5" /></span>
      <span className="truncate">{label}</span>
    </Command.Item>
  );
}

export function CompanyPicker({value, onChange, id}: {value: CompanyLite | null; onChange: (c: CompanyLite | null) => void; id?: string}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const list = useQuery({
    queryKey: ['companies', 'picker', search],
    queryFn: () => api.get<Paged<CompanyLite>>('/companies', {q: search, pageSize: 20, sort: 'name', dir: 'asc'}),
    enabled: open,
  });
  const qc = useQueryClient();
  const name = search.trim();
  const exists = list.data?.rows.some((c) => c.name.toLowerCase() === name.toLowerCase());
  async function create() {
    try {
      const {company} = await api.post<{company: CompanyLite}>('/companies', {name});
      qc.invalidateQueries({queryKey: keys.companies});
      toast.success(`${company.name} created`);
      onChange(company);
      setOpen(false);
      setSearch('');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" id={id} className={trigger}>
          <Building2 className="size-4 text-slate-400" />
          <span className={cn('flex-1 truncate', !value && 'text-slate-400')}>{value?.name ?? 'Select company'}</span>
          {value ? (
            <X className="size-4 text-slate-400 hover:text-slate-700" onClick={(e) => (e.stopPropagation(), onChange(null))} />
          ) : (
            <ChevronsUpDown className="size-4 text-slate-400" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-64">
        <SearchList placeholder="Search companies…" search={search} onSearch={setSearch} loading={list.isFetching}>
          {list.data?.rows.map((c) => (
            <Command.Item key={c.id} value={c.id} onSelect={() => (onChange(c), setOpen(false))} className={itemCls}>
              <Building2 className="size-4 text-slate-400" />
              <span className="flex-1 truncate">{c.name}</span>
              {c.domain && <span className="text-xs text-muted-foreground">{c.domain}</span>}
              {value?.id === c.id && <Check className="size-4 text-primary" />}
            </Command.Item>
          ))}
          {name && !exists && <CreateItem label={`Create company “${name}”`} onSelect={create} />}
        </SearchList>
      </PopoverContent>
    </Popover>
  );
}

export function ContactsPicker({value, onChange, id}: {value: ContactLite[]; onChange: (c: ContactLite[]) => void; id?: string}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const list = useQuery({
    queryKey: ['contacts', 'picker', search],
    queryFn: () => api.get<Paged<ContactLite>>('/contacts', {q: search, pageSize: 20, sort: 'firstName', dir: 'asc'}),
    enabled: open,
  });
  const toggle = (c: ContactLite) => onChange(value.some((v) => v.id === c.id) ? value.filter((v) => v.id !== c.id) : [...value, c]);
  const qc = useQueryClient();
  const text = search.trim();
  async function create() {
    // "jane@acme.com" → email + first name from the local part; "Jane Doe" → first/last name.
    const isEmail = text.includes('@');
    const [first, ...rest] = (isEmail ? text.split('@')[0]!.replace(/[._-]+/g, ' ') : text).split(/\s+/);
    const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
    try {
      const {contact} = await api.post<{contact: ContactLite}>('/contacts', {
        firstName: cap(first ?? text),
        lastName: rest.length ? rest.map(cap).join(' ') : null,
        email: isEmail ? text : null,
      });
      qc.invalidateQueries({queryKey: keys.contacts});
      toast.success(`${fullName(contact)} added`);
      onChange([...value, contact]);
      setSearch('');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  const exists = list.data?.rows.some((c) => fullName(c).toLowerCase() === text.toLowerCase() || c.email?.toLowerCase() === text.toLowerCase());
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" id={id} className={cn(trigger, 'h-auto min-h-10 flex-wrap py-1.5')}>
          <User className="size-4 text-slate-400" />
          {value.length === 0 && <span className="flex-1 text-slate-400">Add people</span>}
          {value.map((c) => (
            <span key={c.id} className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground">
              {fullName(c)}
              <X className="size-3 cursor-pointer" onClick={(e) => (e.stopPropagation(), toggle(c))} />
            </span>
          ))}
          <ChevronsUpDown className="ml-auto size-4 text-slate-400" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-64">
        <SearchList placeholder="Search or add people (name or email)…" search={search} onSearch={setSearch} loading={list.isFetching}>
          {list.data?.rows.map((c) => (
            <Command.Item key={c.id} value={c.id} onSelect={() => toggle(c)} className={itemCls}>
              <Avatar name={fullName(c)} size="xs" />
              <span className="flex-1 truncate">{fullName(c)}</span>
              {c.email && <span className="truncate text-xs text-muted-foreground">{c.email}</span>}
              {value.some((v) => v.id === c.id) && <Check className="size-4 text-primary" />}
            </Command.Item>
          ))}
          {text && !exists && <CreateItem label={`Add new contact “${text}”`} onSelect={create} />}
        </SearchList>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Pick one (or several) values from a list, and add a missing one right from
 * the dropdown. Used for lead source, custom choice fields, etc.
 */
export function CreatableSelect({
  value,
  onChange,
  options,
  onCreate,
  placeholder = 'Select…',
  noun = 'option',
  multiple,
  id,
  createLabel,
}: {
  value: string | string[] | null | undefined;
  onChange: (v: string | string[] | null) => void;
  options: string[];
  /** When set, typing a new value offers "Add …". Persist it here (e.g. to settings). */
  onCreate?: (label: string) => Promise<unknown> | void;
  placeholder?: string;
  noun?: string;
  multiple?: boolean;
  id?: string;
  /** Wording of the create row; default "Add <noun> “…”". */
  createLabel?: (text: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selected = Array.isArray(value) ? value : value ? [value] : [];
  const text = search.trim();
  const shown = options.filter((o) => o.toLowerCase().includes(text.toLowerCase()));
  const exists = [...options, ...selected].some((o) => o.toLowerCase() === text.toLowerCase());

  const pick = (o: string) => {
    if (multiple) onChange(selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o]);
    else (onChange(o), setOpen(false));
    setSearch('');
  };
  async function create() {
    try {
      await onCreate?.(text);
      pick(text);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Popover open={open} onOpenChange={(o) => (setOpen(o), !o && setSearch(''))}>
      <PopoverTrigger asChild>
        <button type="button" id={id} className={cn(trigger, multiple && 'h-auto min-h-10 flex-wrap py-1.5')}>
          {selected.length === 0 && <span className="flex-1 truncate text-slate-400">{placeholder}</span>}
          {multiple
            ? selected.map((o) => (
                <span key={o} className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground">
                  {o}
                  <X className="size-3 cursor-pointer" onClick={(e) => (e.stopPropagation(), pick(o))} />
                </span>
              ))
            : selected[0] && <span className="flex-1 truncate">{selected[0]}</span>}
          {!multiple && selected[0] ? (
            <X className="ml-auto size-4 shrink-0 text-slate-400 hover:text-slate-700" onClick={(e) => (e.stopPropagation(), onChange(null))} />
          ) : (
            <ChevronsUpDown className="ml-auto size-4 shrink-0 text-slate-400" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-56">
        <SearchList placeholder={onCreate ? `Search or add ${noun}…` : `Search…`} search={search} onSearch={setSearch}>
          {shown.map((o) => (
            <Command.Item key={o} value={o} onSelect={() => pick(o)} className={itemCls}>
              <span className="flex-1 truncate">{o}</span>
              {selected.includes(o) && <Check className="size-4 text-primary" />}
            </Command.Item>
          ))}
          {onCreate && text && !exists && <CreateItem label={createLabel ? createLabel(text) : `Add ${noun} “${text}”`} onSelect={create} />}
        </SearchList>
      </PopoverContent>
    </Popover>
  );
}

/** Records that carry tags; the tag pickers suggest the ones already used on that kind. */
export type TagEntity = EntityType | 'TICKET';

/**
 * One tag: a searchable list of the tags already used (on `entity` records), and
 * "Create tag “…”" when what you type isn't there. Tags are stored lowercase.
 */
export function TagSelect({value, onChange, entity, id, placeholder = 'Pick or create a tag'}: {value: string | null | undefined; onChange: (tag: string) => void; entity?: TagEntity; id?: string; placeholder?: string}) {
  const known = useQuery({
    queryKey: [...keys.tags, entity ?? 'all'],
    queryFn: () => api.get<{rows: {tag: string; n: number}[]}>('/tags', {entity}),
    select: (d) => d.rows.map((r) => r.tag),
    staleTime: 60_000,
  });
  return (
    <CreatableSelect
      id={id}
      value={value || null}
      onChange={(v) => onChange(typeof v === 'string' ? v.trim().toLowerCase() : '')}
      options={known.data ?? []}
      onCreate={() => undefined}
      noun="tag"
      placeholder={placeholder}
      createLabel={(text) => `Create tag “${text.trim().toLowerCase()}”`}
    />
  );
}

/**
 * Chips input with a suggestion dropdown. Existing tags (for `entity`) are
 * offered as you type; anything new can be added on the spot with Enter,
 * comma, or the "Create tag" row.
 */
export function TagInput({
  value,
  onChange,
  entity,
  suggestions = [],
  id,
  lowercase = true,
  noun = 'tag',
}: {
  value: string[];
  onChange: (v: string[]) => void;
  entity?: TagEntity;
  suggestions?: string[];
  id?: string;
  lowercase?: boolean;
  noun?: string;
}) {
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const known = useQuery({
    queryKey: [...keys.tags, entity ?? 'none'],
    queryFn: () => api.get<{rows: {tag: string; n: number}[]}>('/tags', {entity}),
    select: (d) => d.rows.map((r) => r.tag),
    enabled: !!entity && focused,
    staleTime: 60_000,
  });

  const norm = (t: string) => (lowercase ? t.trim().toLowerCase() : t.trim());
  const q = norm(draft);
  const pool = [...new Set([...(known.data ?? []), ...suggestions])].filter((t) => !value.includes(t));
  const matches = pool.filter((t) => t.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  const canCreate = !!q && !value.includes(q) && !pool.some((t) => t.toLowerCase() === q.toLowerCase());
  const items = [...matches.map((t) => ({tag: t, create: false})), ...(canCreate ? [{tag: q, create: true}] : [])];
  const open = focused && items.length > 0;

  useEffect(() => setActive(0), [draft]);

  const add = (t: string) => {
    const tag = norm(t);
    if (tag && !value.includes(tag)) onChange([...value, tag]);
    setDraft('');
    inputRef.current?.focus();
  };

  return (
    <Popover open={open}>
      <PopoverAnchor asChild>
        <div
          onClick={() => inputRef.current?.focus()}
          className="flex min-h-10 cursor-text flex-wrap items-center gap-1.5 rounded-lg border border-input bg-card px-2 py-1.5 shadow-xs focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25"
        >
          {value.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 rounded-full bg-teal-50 px-2 py-0.5 text-xs font-semibold text-teal-700">
              {t}
              <button type="button" aria-label={`Remove ${t}`} className="cursor-pointer" onClick={(e) => (e.stopPropagation(), onChange(value.filter((x) => x !== t)))}>
                <X className="size-3" />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            id={id}
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            value={draft}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              if (draft.trim()) add(draft);
            }}
            onChange={(e) => (setFocused(true), e.target.value.endsWith(',') ? add(e.target.value.slice(0, -1)) : setDraft(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && open) (e.preventDefault(), setActive((a) => (a + 1) % items.length));
              else if (e.key === 'ArrowUp' && open) (e.preventDefault(), setActive((a) => (a - 1 + items.length) % items.length));
              else if (e.key === 'Enter') {
                e.preventDefault();
                const pickItem = open && draft ? items[active] : undefined;
                add(pickItem ? pickItem.tag : draft);
              } else if (e.key === 'Escape') setFocused(false);
              else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
            }}
            placeholder={value.length ? '' : `Add ${noun}…`}
            className="min-w-20 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-slate-400"
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        className="w-[var(--radix-popper-anchor-width)] min-w-56 p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        // Keep focus in the input while clicking a suggestion.
        onMouseDown={(e) => e.preventDefault()}
      >
        <div role="listbox">
          {!draft && matches.length > 0 && <p className="px-2.5 pt-1.5 pb-1 text-[11px] font-bold tracking-wider text-slate-400 uppercase">Existing {noun}s</p>}
          {items.map((it, i) => (
            <button
              key={`${it.create}-${it.tag}`}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => add(it.tag)}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-slate-700',
                i === active && 'bg-accent text-accent-foreground',
                it.create && 'mt-1 border-t border-slate-100 pt-2.5 font-semibold text-primary',
              )}
            >
              {it.create ? (
                <span className="flex size-5 items-center justify-center rounded-md bg-brand text-white"><Plus className="size-3.5" /></span>
              ) : (
                <Tag className="size-3.5 text-slate-400" />
              )}
              <span className="truncate">{it.create ? `Create ${noun} “${it.tag}”` : it.tag}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** One contact, by id (keeps the picked record locally for display). */
export function SingleContactPicker({onChange, exclude}: {onChange: (id: string | null) => void; exclude?: string}) {
  const [picked, setPicked] = useState<ContactLite[]>([]);
  return (
    <ContactsPicker
      value={picked}
      onChange={(v) => {
        const next = v.filter((c) => c.id !== exclude).slice(-1);
        setPicked(next);
        onChange(next[0]?.id ?? null);
      }}
    />
  );
}

/** One company, by id. */
export function SingleCompanyPicker({onChange, exclude}: {onChange: (id: string | null) => void; exclude?: string}) {
  const [picked, setPicked] = useState<CompanyLite | null>(null);
  return (
    <CompanyPicker
      value={picked}
      onChange={(c) => {
        const next = c && c.id !== exclude ? c : null;
        setPicked(next);
        onChange(next?.id ?? null);
      }}
    />
  );
}

/** One deal, searched across all pipelines. */
export function DealPicker({value, onChange, id}: {value: {id: string; title: string} | null; onChange: (d: {id: string; title: string} | null) => void; id?: string}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const list = useQuery({
    queryKey: ['deals', 'picker', search],
    queryFn: () => api.get<{rows: {id: string; title: string; status: string; stage: {name: string}; company: {name: string} | null}[]}>('/deals', {q: search, status: 'ALL', take: 20}),
    enabled: open,
  });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" id={id} className={trigger}>
          <span className={cn('flex-1 truncate', !value && 'text-slate-400')}>{value?.title ?? 'Select deal'}</span>
          {value ? <X className="size-4 text-slate-400 hover:text-slate-700" onClick={(e) => (e.stopPropagation(), onChange(null))} /> : <ChevronsUpDown className="size-4 text-slate-400" />}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-64">
        <SearchList placeholder="Search deals…" search={search} onSearch={setSearch} loading={list.isFetching}>
          {list.data?.rows.map((d) => (
            <Command.Item key={d.id} value={d.id} onSelect={() => (onChange({id: d.id, title: d.title}), setOpen(false))} className={itemCls}>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{d.title}</span>
                <span className="block truncate text-xs text-muted-foreground">{d.status === 'OPEN' ? d.stage.name : d.status.toLowerCase()}{d.company ? ` · ${d.company.name}` : ''}</span>
              </span>
              {value?.id === d.id && <Check className="size-4 text-primary" />}
            </Command.Item>
          ))}
        </SearchList>
      </PopoverContent>
    </Popover>
  );
}
