import {closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent} from '@dnd-kit/core';
import {arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy} from '@dnd-kit/sortable';
import {CSS} from '@dnd-kit/utilities';
import {
  AlignLeft,
  AtSign,
  Building2,
  Calendar,
  CalendarClock,
  ChevronDown,
  CircleDot,
  Copy,
  EyeOff,
  FileUp,
  Globe,
  GitBranch,
  GripVertical,
  Hash,
  Heading,
  Link2,
  ListChecks,
  MapPin,
  Phone,
  Plus,
  Scissors,
  ShieldCheck,
  Star,
  ToggleLeft,
  Trash2,
  Type,
  User,
  X,
} from 'lucide-react';
import {useState, type ReactNode} from 'react';

import {AUTO_MAP, defaultField, FIELD_GROUPS, FIELD_LABEL, hasOptions, isInput, MAP_TARGETS, newId, type FieldType, type FormField, type FormSettings} from '@/lib/forms';
import {useFields} from '@/lib/queries';
import {cn} from '@/lib/utils';

import {Button} from '../ui/button';
import {Card} from '../ui/card';
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '../ui/dialog';
import {Field, Input, NativeSelect, Switch, Textarea} from '../ui/form';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger} from '../ui/menu';
import {BookingLinkField} from '../booking/link-field';
import {RuleGroupEditor} from './logic-editor';
import {accentStyle, FieldControl, FieldLabel} from './renderer';

export const FIELD_ICONS: Record<FieldType, typeof Type> = {
  name: User,
  email: AtSign,
  phone: Phone,
  company: Building2,
  website: Globe,
  address: MapPin,
  short_text: Type,
  long_text: AlignLeft,
  number: Hash,
  date: Calendar,
  dropdown: ChevronDown,
  single_choice: CircleDot,
  multiple_choice: ListChecks,
  yes_no: ToggleLeft,
  consent: ShieldCheck,
  rating: Star,
  file: FileUp,
  hidden: EyeOff,
  booking: CalendarClock,
  heading: Heading,
  page_break: Scissors,
};

const ACCENTS = ['', '#2563eb', '#4f46e5', '#7c3aed', '#db2777', '#e11d48', '#ea580c', '#16a34a', '#0d9488', '#0f172a'];

type Props = {
  fields: FormField[];
  settings: FormSettings;
  onFields: (f: FormField[]) => void;
  onSettings: (s: FormSettings) => void;
};

/** Build tab: palette, live canvas (drag to reorder) and the inspector for the selected field. */
export function FormBuilder({fields, settings, onFields, onSettings}: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false); // inspector as a sheet below xl
  const sensors = useSensors(useSensor(PointerSensor, {activationConstraint: {distance: 5}}), useSensor(KeyboardSensor, {coordinateGetter: sortableKeyboardCoordinates}));
  const current = fields.find((f) => f.id === selected) ?? null;

  function add(type: FieldType) {
    const field = defaultField(type);
    const at = selected ? fields.findIndex((f) => f.id === selected) + 1 : fields.length;
    onFields([...fields.slice(0, at), field, ...fields.slice(at)]);
    setSelected(field.id);
    requestAnimationFrame(() => document.getElementById(`canvas_${field.id}`)?.scrollIntoView({behavior: 'smooth', block: 'nearest'}));
  }
  const update = (id: string, patch: Partial<FormField>) => onFields(fields.map((f) => (f.id === id ? {...f, ...patch} : f)));
  function remove(id: string) {
    // Rules pointing at a removed field are dropped too.
    onFields(
      fields
        .filter((f) => f.id !== id)
        .map((f) => (f.logic ? {...f, logic: {...f.logic, rules: f.logic.rules.filter((r) => r.fieldId !== id)}} : f)),
    );
    if (selected === id) setSelected(null);
  }
  function duplicate(id: string) {
    const i = fields.findIndex((f) => f.id === id);
    const copy = {...fields[i]!, id: newId(), label: `${fields[i]!.label} (copy)`};
    onFields([...fields.slice(0, i + 1), copy, ...fields.slice(i + 1)]);
    setSelected(copy.id);
  }
  function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    const from = fields.findIndex((f) => f.id === e.active.id);
    const to = fields.findIndex((f) => f.id === e.over!.id);
    onFields(arrayMove(fields, from, to));
  }
  const select = (id: string | null) => {
    setSelected(id);
    if (id && window.matchMedia('(max-width: 1279px)').matches) setSheet(true);
  };

  const inspector = current ? (
    <FieldInspector key={current.id} field={current} earlier={fields.slice(0, fields.indexOf(current))} onChange={(p) => update(current.id, p)} onRemove={() => remove(current.id)} onClose={() => (setSelected(null), setSheet(false))} />
  ) : (
    <FormAppearance settings={settings} onChange={onSettings} />
  );

  let pageNo = 1;
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[220px_minmax(0,1fr)_320px]">
      {/* Palette */}
      <div className="hidden content-start xl:grid">
        <Card className="sticky top-20 max-h-[calc(100dvh-6rem)] overflow-y-auto p-3 scrollbar-thin">
          <Palette onAdd={add} />
        </Card>
      </div>

      {/* Canvas */}
      <div className="min-w-0">
        <div className="mb-3 flex items-center justify-between xl:hidden">
          <AddFieldMenu onAdd={add} />
          <Button variant="secondary" size="sm" onClick={() => (setSelected(null), setSheet(true))}>Form style</Button>
        </div>
        <Card className="@container p-5 sm:p-8" style={accentStyle(settings.accent)} onClick={(e) => e.target === e.currentTarget && setSelected(null)}>
          {(settings.title || settings.intro) && (
            <button type="button" onClick={() => select(null)} className="mb-6 block w-full cursor-pointer rounded-xl p-2 text-left hover:bg-slate-50">
              {settings.title && <h2 className="text-2xl font-extrabold tracking-tight text-slate-900">{settings.title}</h2>}
              {settings.intro && <p className="mt-1.5 whitespace-pre-line text-muted-foreground">{settings.intro}</p>}
            </button>
          )}
          {fields.length === 0 && (
            <div className="rounded-xl border-2 border-dashed border-slate-200 p-10 text-center text-sm text-muted-foreground">
              Add your first question from the panel{' '}
              <span className="xl:hidden">with “Add field”</span>
              <span className="hidden xl:inline">on the left</span>.
            </div>
          )}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {fields.map((f) => (
                  <CanvasItem
                    key={f.id}
                    field={f}
                    page={f.type === 'page_break' ? ++pageNo : undefined}
                    selected={selected === f.id}
                    onSelect={() => select(f.id)}
                    onDuplicate={() => duplicate(f.id)}
                    onRemove={() => remove(f.id)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
          <div className="mt-6 flex items-center gap-3 border-t border-dashed border-slate-200 pt-5">
            <Button type="button" tabIndex={-1} className="pointer-events-none">{settings.submitLabel || 'Submit'}</Button>
            <span className="text-xs text-muted-foreground">Respondents see this button on the last page.</span>
          </div>
        </Card>
      </div>

      {/* Inspector */}
      <div className="hidden content-start xl:grid">
        <Card className="sticky top-20 max-h-[calc(100dvh-6rem)] overflow-y-auto scrollbar-thin">{inspector}</Card>
      </div>
      <Dialog open={sheet} onOpenChange={setSheet}>
        <DialogContent size="sm" className="xl:hidden">
          <DialogHeader>
            <DialogTitle>{current ? FIELD_LABEL[current.type] : 'Form style'}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">{inspector}</div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Palette({onAdd}: {onAdd: (t: FieldType) => void}) {
  return (
    <div className="grid gap-4">
      {FIELD_GROUPS.map((g) => (
        <div key={g.label}>
          <p className="mb-1.5 px-1 text-[11px] font-bold tracking-wide text-slate-400 uppercase">{g.label}</p>
          <div className="grid gap-0.5">
            {g.types.map((t) => {
              const Icon = FIELD_ICONS[t.type];
              return (
                <button
                  key={t.type}
                  type="button"
                  onClick={() => onAdd(t.type)}
                  title={t.hint}
                  className="group flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-slate-700 transition-colors hover:bg-primary/[0.07] hover:text-slate-900"
                >
                  <span className="flex size-7 items-center justify-center rounded-md bg-slate-100 text-slate-500 group-hover:bg-primary/15 group-hover:text-primary">
                    <Icon className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{t.label}</span>
                  <Plus className="size-3.5 text-slate-300 opacity-0 group-hover:opacity-100" />
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function AddFieldMenu({onAdd}: {onAdd: (t: FieldType) => void}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm"><Plus /> Add field</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[70vh] w-60 overflow-y-auto">
        {FIELD_GROUPS.map((g, i) => (
          <div key={g.label}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel>{g.label}</DropdownMenuLabel>
            {g.types.map((t) => {
              const Icon = FIELD_ICONS[t.type];
              return <DropdownMenuItem key={t.type} onSelect={() => onAdd(t.type)}><Icon /> {t.label}</DropdownMenuItem>;
            })}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CanvasItem({field: f, page, selected, onSelect, onDuplicate, onRemove}: {field: FormField; page?: number; selected: boolean; onSelect: () => void; onDuplicate: () => void; onRemove: () => void}) {
  const {attributes, listeners, setNodeRef, transform, transition, isDragging} = useSortable({id: f.id});
  const style = {transform: CSS.Translate.toString(transform), transition};
  const conditional = !!f.logic?.rules.some((r) => r.fieldId);
  const wide = f.width !== 'half' || !isInput(f.type) || f.type === 'hidden';

  const toolbar = (
    <div className={cn('absolute -top-3 left-2 z-10 flex items-center gap-0.5 rounded-lg border border-slate-200 bg-card p-0.5 shadow-soft transition-opacity', selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}>
      <button type="button" {...attributes} {...listeners} className="cursor-grab rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 active:cursor-grabbing" aria-label="Drag to reorder">
        <GripVertical className="size-3.5" />
      </button>
      <button type="button" onClick={(e) => (e.stopPropagation(), onDuplicate())} className="cursor-pointer rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Duplicate">
        <Copy className="size-3.5" />
      </button>
      <button type="button" onClick={(e) => (e.stopPropagation(), onRemove())} className="cursor-pointer rounded-md p-1 text-slate-400 hover:bg-rose-50 hover:text-destructive" aria-label="Delete">
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );

  return (
    <div
      ref={setNodeRef}
      id={`canvas_${f.id}`}
      style={style}
      onClick={onSelect}
      className={cn(
        'group relative min-w-0 cursor-pointer rounded-xl border-2 p-3 transition-colors',
        wide && 'sm:col-span-2',
        selected ? 'border-primary bg-primary/[0.03]' : 'border-transparent hover:border-slate-200 hover:bg-slate-50/60',
        isDragging && 'z-20 opacity-80 shadow-lift',
      )}
    >
      {toolbar}
      {(conditional || f.mapTo) && (
        <div className="absolute top-2.5 right-3 flex gap-1">
          {conditional && (
            <span title={f.logic!.action === 'show' ? 'Shown only when its rules match' : 'Hidden when its rules match'} className="flex size-5 items-center justify-center rounded-md bg-violet-100 text-violet-600 dark:bg-violet-500/20">
              <GitBranch className="size-3" />
            </span>
          )}
          {f.mapTo && (
            <span title={`Saves to ${MAP_TARGETS.find((m) => m.value === f.mapTo)?.label ?? f.mapTo.replace('contact.custom.', 'Contact · ')}`} className="flex size-5 items-center justify-center rounded-md bg-teal-100 text-teal-600 dark:bg-teal-500/20">
              <Link2 className="size-3" />
            </span>
          )}
        </div>
      )}
      {f.type === 'page_break' ? (
        <div className="flex items-center gap-3 py-1 text-xs font-semibold text-slate-500">
          <span className="h-px flex-1 bg-slate-200" />
          <Scissors className="size-3.5" /> Page {page}
          {f.label && <span className="text-slate-700">· {f.label}</span>}
          <span className="h-px flex-1 bg-slate-200" />
        </div>
      ) : f.type === 'hidden' ? (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-500">
          <EyeOff className="size-3.5" /> Hidden field <code className="font-semibold text-slate-700">{f.label}</code>
          {f.param && <span>← ?{f.param}=</span>}
          {f.defaultValue && <span>(default “{f.defaultValue}”)</span>}
        </div>
      ) : (
        <div className="pointer-events-none" aria-hidden>
          <FieldLabel field={f} />
          <FieldControl field={f} value={null} onChange={() => {}} />
        </div>
      )}
    </div>
  );
}

// ─── Inspector ──────────────────────────────────────────────────────────────

function Section({title, children}: {title: string; children: ReactNode}) {
  return (
    <div className="grid gap-3 border-b border-slate-100 px-4 py-4 last:border-0">
      <p className="text-[11px] font-bold tracking-wide text-slate-400 uppercase">{title}</p>
      {children}
    </div>
  );
}

function FieldInspector({field: f, earlier, onChange, onRemove, onClose}: {field: FormField; earlier: FormField[]; onChange: (p: Partial<FormField>) => void; onRemove: () => void; onClose: () => void}) {
  const contactFields = useFields('CONTACT');
  const Icon = FIELD_ICONS[f.type];
  const text = ['short_text', 'long_text', 'email', 'phone', 'company', 'website', 'number', 'dropdown'].includes(f.type);
  const mappable = !AUTO_MAP[f.type] && isInput(f.type) && !['consent', 'file', 'booking'].includes(f.type);
  const logic = f.logic ?? {action: 'show' as const, match: 'all' as const, rules: []};
  const logicOn = !!f.logic;

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
        <span className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary"><Icon className="size-3.5" /></span>
        <p className="min-w-0 flex-1 text-sm font-bold text-slate-900">{FIELD_LABEL[f.type]}</p>
        <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label="Delete field" className="text-slate-400 hover:text-destructive"><Trash2 /></Button>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close" className="hidden xl:inline-flex"><X /></Button>
      </div>

      <Section title="Content">
        {f.type === 'hidden' ? (
          <>
            <Field label="Name" hint="Column name in responses and exports.">
              <Input value={f.label} onChange={(e) => onChange({label: e.target.value})} />
            </Field>
            <Field label="Read from URL parameter" hint={<>e.g. <code>utm_campaign</code> reads <code>?utm_campaign=spring</code></>}>
              <Input value={f.param ?? ''} onChange={(e) => onChange({param: e.target.value.trim()})} placeholder="utm_campaign" />
            </Field>
            <Field label="Default value" hint="Used when the parameter is missing.">
              <Input value={f.defaultValue ?? ''} onChange={(e) => onChange({defaultValue: e.target.value})} />
            </Field>
          </>
        ) : (
          <>
            <Field label={f.type === 'page_break' ? 'Page title' : f.type === 'consent' ? 'Consent text' : f.type === 'heading' ? 'Heading' : 'Question'}>
              {f.type === 'consent' ? (
                <Textarea rows={3} value={f.label} onChange={(e) => onChange({label: e.target.value})} />
              ) : (
                <Input value={f.label} onChange={(e) => onChange({label: e.target.value})} autoFocus />
              )}
            </Field>
            {f.type !== 'page_break' && f.type !== 'consent' && (
              <Field label={f.type === 'heading' ? 'Text' : 'Help text'}>
                <Textarea rows={2} value={f.description ?? ''} onChange={(e) => onChange({description: e.target.value || undefined})} placeholder={f.type === 'heading' ? '' : 'Shown under the question'} />
              </Field>
            )}
            {text && (
              <Field label="Placeholder">
                <Input value={f.placeholder ?? ''} onChange={(e) => onChange({placeholder: e.target.value || undefined})} />
              </Field>
            )}
          </>
        )}
      </Section>

      {hasOptions(f.type) && (
        <Section title="Options">
          <OptionsEditor options={f.options ?? []} onChange={(options) => onChange({options})} />
        </Section>
      )}

      {(f.type === 'rating' || f.type === 'number' || f.type === 'file' || f.type === 'booking') && (
        <Section title="Settings">
          {f.type === 'rating' && (
            <Field label="Stars">
              <NativeSelect value={f.scale ?? 5} onChange={(e) => onChange({scale: Number(e.target.value)})}>
                {[3, 4, 5, 6, 7, 8, 9, 10].map((n) => <option key={n} value={n}>{n}</option>)}
              </NativeSelect>
            </Field>
          )}
          {f.type === 'number' && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Minimum"><Input type="number" value={f.min ?? ''} onChange={(e) => onChange({min: e.target.value === '' ? undefined : Number(e.target.value)})} /></Field>
              <Field label="Maximum"><Input type="number" value={f.max ?? ''} onChange={(e) => onChange({max: e.target.value === '' ? undefined : Number(e.target.value)})} /></Field>
            </div>
          )}
          {f.type === 'booking' && <BookingLinkField value={f.bookingLinkId} onChange={(bookingLinkId) => onChange({bookingLinkId})} />}
          {f.type === 'file' && (
            <Field label="Allowed files" hint="Up to 5 files, 5 MB each.">
              <NativeSelect value={f.accept ?? 'any'} onChange={(e) => onChange({accept: e.target.value as FormField['accept']})}>
                <option value="any">Any file</option>
                <option value="images">Images only</option>
                <option value="documents">Documents only (PDF, Word, Excel…)</option>
              </NativeSelect>
            </Field>
          )}
        </Section>
      )}

      {isInput(f.type) && f.type !== 'hidden' && (
        <Section title="Rules">
          <label className="flex cursor-pointer items-center justify-between gap-3 text-sm font-medium text-slate-700">
            Required
            <Switch checked={!!f.required} onCheckedChange={(v) => onChange({required: v})} />
          </label>
          {f.type !== 'consent' && (
            <label className="flex cursor-pointer items-center justify-between gap-3 text-sm font-medium text-slate-700">
              Half width (two per row)
              <Switch checked={f.width === 'half'} onCheckedChange={(v) => onChange({width: v ? 'half' : 'full'})} />
            </label>
          )}
        </Section>
      )}

      {(mappable || AUTO_MAP[f.type]) && (
        <Section title="Save answer to">
          {AUTO_MAP[f.type] ? (
            <p className="text-sm text-slate-600">
              Saved to the contact{f.type === 'company' || f.type === 'website' ? "'s company" : ''} automatically.
              {f.type === 'email' && ' A known email updates the existing contact.'}
            </p>
          ) : (
            <Field hint="The answer is always kept on the response; mapping also copies it to a property.">
              <NativeSelect value={f.mapTo ?? ''} onChange={(e) => onChange({mapTo: e.target.value || undefined})}>
                <option value="">Only keep on the response</option>
                <optgroup label="Properties">
                  {MAP_TARGETS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </optgroup>
                {!!contactFields.data?.length && (
                  <optgroup label="Contact custom fields">
                    {contactFields.data.map((cf) => <option key={cf.id} value={`contact.custom.${cf.key}`}>{cf.label}</option>)}
                  </optgroup>
                )}
              </NativeSelect>
            </Field>
          )}
        </Section>
      )}

      {f.type !== 'heading' && f.type !== 'hidden' && (
        <Section title={f.type === 'page_break' ? 'Page logic' : 'Conditional logic'}>
          <label className="flex cursor-pointer items-center justify-between gap-3 text-sm font-medium text-slate-700">
            {f.type === 'page_break' ? 'Only show this page when…' : 'Only show this question when…'}
            <Switch checked={logicOn} onCheckedChange={(v) => onChange({logic: v ? {...logic, rules: logic.rules.length ? logic.rules : [{fieldId: '', op: 'is', value: ''}]} : undefined})} />
          </label>
          {logicOn && (
            <>
              <NativeSelect className="h-8 py-0 text-xs" value={logic.action} onChange={(e) => onChange({logic: {...logic, action: e.target.value as 'show' | 'hide'}})}>
                <option value="show">Show when the rules match</option>
                <option value="hide">Hide when the rules match</option>
              </NativeSelect>
              <RuleGroupEditor group={logic} sources={earlier} onChange={(g) => onChange({logic: {...logic, ...g}})} />
            </>
          )}
        </Section>
      )}
    </div>
  );
}

function OptionsEditor({options, onChange}: {options: string[]; onChange: (o: string[]) => void}) {
  const [bulk, setBulk] = useState<string | null>(null);
  if (bulk !== null) {
    return (
      <div className="grid gap-2">
        <Textarea rows={6} value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder="One option per line" autoFocus />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setBulk(null)}>Cancel</Button>
          <Button size="sm" onClick={() => (onChange([...new Set(bulk.split('\n').map((s) => s.trim()).filter(Boolean))]), setBulk(null))}>Apply</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-1.5">
      {options.map((o, i) => (
        <div key={i} className="flex gap-1.5">
          <Input
            className="h-8 text-sm"
            value={o}
            onChange={(e) => onChange(options.map((x, j) => (j === i ? e.target.value : x)))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onChange([...options.slice(0, i + 1), '', ...options.slice(i + 1)]);
              }
            }}
            aria-label={`Option ${i + 1}`}
          />
          <Button variant="ghost" size="icon-sm" className="shrink-0" disabled={options.length <= 1} onClick={() => onChange(options.filter((_, j) => j !== i))} aria-label="Remove option"><X /></Button>
        </div>
      ))}
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" onClick={() => onChange([...options, `Option ${options.length + 1}`])}><Plus /> Add option</Button>
        <Button size="sm" variant="ghost" onClick={() => setBulk(options.join('\n'))}>Paste a list</Button>
      </div>
    </div>
  );
}

function FormAppearance({settings: s, onChange}: {settings: FormSettings; onChange: (s: FormSettings) => void}) {
  const set = (p: Partial<FormSettings>) => onChange({...s, ...p});
  return (
    <div>
      <div className="border-b border-slate-100 px-4 py-3">
        <p className="text-sm font-bold text-slate-900">Form style</p>
        <p className="text-xs text-muted-foreground">Click a field on the canvas to edit it.</p>
      </div>
      <Section title="Header">
        <Field label="Title"><Input value={s.title ?? ''} onChange={(e) => set({title: e.target.value})} placeholder="Shown at the top" /></Field>
        <Field label="Intro"><Textarea rows={3} value={s.intro ?? ''} onChange={(e) => set({intro: e.target.value})} placeholder="A sentence on why they should fill it in" /></Field>
        <Field label="Submit button"><Input value={s.submitLabel ?? ''} onChange={(e) => set({submitLabel: e.target.value})} placeholder="Submit" maxLength={60} /></Field>
      </Section>
      <Section title="Layout">
        <div className="grid grid-cols-2 gap-2">
          {(['classic', 'conversational'] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => set({layout: l})}
              className={cn('cursor-pointer rounded-xl border p-2.5 text-left transition-all', s.layout === l ? 'border-primary bg-primary/[0.06] ring-1 ring-primary' : 'border-slate-200 hover:border-primary/50')}
            >
              <p className="text-sm font-semibold text-slate-900">{l === 'classic' ? 'Classic' : 'One at a time'}</p>
              <p className="text-[11px] leading-snug text-muted-foreground">{l === 'classic' ? 'All questions, split by page breaks' : 'One question per screen'}</p>
            </button>
          ))}
        </div>
        <label className="flex cursor-pointer items-center justify-between gap-3 text-sm font-medium text-slate-700">
          Progress bar
          <Switch checked={s.progressBar} onCheckedChange={(v) => set({progressBar: v})} />
        </label>
      </Section>
      <Section title="Accent colour">
        <div className="flex flex-wrap gap-2">
          {ACCENTS.map((c) => (
            <button
              key={c || 'brand'}
              type="button"
              onClick={() => set({accent: c})}
              title={c || 'Brand colours'}
              className={cn('size-8 cursor-pointer rounded-full ring-offset-2 ring-offset-card transition-transform hover:scale-110', (s.accent ?? '') === c && 'ring-2 ring-slate-900')}
              style={{background: c || 'linear-gradient(135deg, var(--primary), var(--secondary))'}}
              aria-label={c || 'Brand colours'}
            />
          ))}
          <label className="relative size-8 cursor-pointer overflow-hidden rounded-full border border-slate-200" title="Custom colour">
            <input type="color" className="absolute inset-0 size-full cursor-pointer opacity-0" value={s.accent || '#2563eb'} onChange={(e) => set({accent: e.target.value})} />
            <span className="flex size-full items-center justify-center text-slate-400"><Plus className="size-4" /></span>
          </label>
        </div>
      </Section>
    </div>
  );
}

