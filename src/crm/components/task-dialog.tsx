import {useQueryClient} from '@tanstack/react-query';
import {Building2, Handshake, Repeat, User} from 'lucide-react';
import {useMemo, useState} from 'react';
import {toast} from 'sonner';

import {api} from '@/lib/api';
import {TASK_TYPES, toDateInput} from '@/lib/format';
import {keys, recordKeys, useMe, useSettings} from '@/lib/queries';
import type {CompanyLite, ContactLite, Priority, Task, TaskType} from '@/lib/types';
import {cn} from '@/lib/utils';

import {TASK_ICONS, type TaskDefaults} from './create-dialogs';
import {CompanyPicker, ContactsPicker, CreatableSelect, DealPicker, UserSelect} from './pickers';
import {Button} from './ui/button';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from './ui/dialog';
import {Checkbox, Field, Input, Label, NativeSelect, Textarea} from './ui/form';
import {is, useFormState} from './ui/form-state';

// ─── Date helpers ───

function addBusinessDays(days: number) {
  const d = new Date();
  let left = days;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) left--;
  }
  return d;
}

function addDays(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

function addMonths(months: number) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d;
}

const weekday = (d: Date) => d.toLocaleDateString('en-US', {weekday: 'long'});

/** HubSpot-style relative due dates. Labels are computed, e.g. "In 3 business days (Tuesday)". */
function duePresets() {
  const p: {id: string; label: string; date: () => Date}[] = [
    {id: 'today', label: 'Today', date: () => new Date()},
    {id: 'tomorrow', label: `Tomorrow (${weekday(addDays(1))})`, date: () => addDays(1)},
    {id: 'bd2', label: `In 2 business days (${weekday(addBusinessDays(2))})`, date: () => addBusinessDays(2)},
    {id: 'bd3', label: `In 3 business days (${weekday(addBusinessDays(3))})`, date: () => addBusinessDays(3)},
    {id: 'w1', label: 'In 1 week', date: () => addDays(7)},
    {id: 'w2', label: 'In 2 weeks', date: () => addDays(14)},
    {id: 'm1', label: 'In 1 month', date: () => addMonths(1)},
    {id: 'm3', label: 'In 3 months', date: () => addMonths(3)},
    {id: 'm6', label: 'In 6 months', date: () => addMonths(6)},
  ];
  return p;
}

const REPEAT = [
  ['DAILY', 'Daily'],
  ['WEEKDAYS', 'Every weekday (Mon–Fri)'],
  ['WEEKLY', 'Weekly'],
  ['MONTHLY', 'Monthly'],
  ['QUARTERLY', 'Every 3 months'],
  ['YEARLY', 'Yearly'],
] as const;

const REMINDERS = [
  ['none', 'No reminder'],
  ['0', 'At task due time'],
  ['15', '15 minutes before'],
  ['30', '30 minutes before'],
  ['60', '1 hour before'],
  ['1440', '1 day before'],
  ['10080', '1 week before'],
  ['custom', 'Custom date and time'],
] as const;

const PRIORITIES: [Priority, string, string][] = [
  ['NONE', 'None', 'bg-slate-300'],
  ['LOW', 'Low', 'bg-sky-400'],
  ['NORMAL', 'Medium', 'bg-amber-400'],
  ['HIGH', 'High', 'bg-rose-500'],
];

const pad = (n: number) => String(n).padStart(2, '0');
const timeOf = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const localStamp = (d: Date) => `${toDateInput(d.toISOString())}T${timeOf(d)}`;

/**
 * Create or edit a task in a side panel, like HubSpot: relative due dates,
 * repeat, assignee, type, associations, priority, queue, reminder, notes,
 * and "Create and add another".
 */
export function TaskDialog({defaults, task, onClose}: {defaults?: TaskDefaults; task?: Task; onClose: () => void}) {
  const {me} = useMe();
  const qc = useQueryClient();
  const settings = useSettings();
  const presets = useMemo(duePresets, []);
  const due = task?.dueAt ? new Date(task.dueAt) : null;

  const blank = () => ({
    title: defaults?.title ?? '',
    type: (defaults?.type ?? 'TODO') as TaskType,
    priority: 'NONE' as Priority,
    preset: 'bd3',
    date: toDateInput(addBusinessDays(3).toISOString()),
    time: '08:00',
    repeatOn: false,
    repeat: 'WEEKLY' as string,
    assigneeId: me.id as string | null,
    queue: null as string | null,
    reminder: 'none' as string,
    reminderAt: '',
    description: '',
  });
  const [form, setForm] = useState(() =>
    task
      ? {
          title: task.title,
          type: task.type,
          priority: task.priority,
          preset: due ? 'custom' : 'none',
          date: due ? toDateInput(task.dueAt) : '',
          time: due ? timeOf(due) : '08:00',
          repeatOn: !!task.repeat,
          repeat: task.repeat ?? 'WEEKLY',
          assigneeId: task.assigneeId,
          queue: task.queue,
          reminder: task.reminderAt ? 'custom' : 'none',
          reminderAt: task.reminderAt ? localStamp(new Date(task.reminderAt)) : '',
          description: task.description ?? '',
        }
      : blank(),
  );
  const [contacts, setContacts] = useState<ContactLite[]>(
    task?.contact ? [task.contact] : defaults?.contactId ? [{id: defaults.contactId, firstName: defaults.contactName ?? 'Contact', lastName: null}] : [],
  );
  const [company, setCompany] = useState<CompanyLite | null>(
    task?.company ? {...task.company, domain: null} : defaults?.companyId ? {id: defaults.companyId, name: defaults.companyName ?? 'Company', domain: null} : null,
  );
  const [deal, setDeal] = useState<{id: string; title: string} | null>(task?.deal ?? (defaults?.dealId ? {id: defaults.dealId, title: defaults.dealTitle ?? 'Deal'} : null));
  const [busy, setBusy] = useState<false | 'close' | 'another'>(false);
  const f = useFormState(form, {
    title: [is.required('Give the task a title.'), is.maxLength(300)],
    date: [(v, all) => (all.preset === 'custom' && !v ? 'Choose a due date, or pick "No due date".' : null)],
    reminderAt: [(v, all) => (all.reminder === 'custom' && !v ? 'Choose when to remind you, or pick "No reminder".' : null)],
    description: [is.maxLength(5000)],
  });

  const dueDate = form.preset === 'none' || !form.date ? null : new Date(`${form.date}T${form.time || '08:00'}`);
  const reminderDate =
    form.reminder === 'none' || !dueDate
      ? form.reminder === 'custom' && form.reminderAt
        ? new Date(form.reminderAt)
        : null
      : form.reminder === 'custom'
        ? form.reminderAt
          ? new Date(form.reminderAt)
          : null
        : new Date(dueDate.getTime() - Number(form.reminder) * 60_000);
  const associated = contacts.length + (company ? 1 : 0) + (deal ? 1 : 0);

  const pickPreset = (id: string) => {
    if (id === 'custom' || id === 'none') return setForm({...form, preset: id, date: id === 'none' ? '' : form.date || toDateInput(new Date().toISOString())});
    const p = presets.find((x) => x.id === id)!;
    setForm({...form, preset: id, date: toDateInput(p.date().toISOString())});
  };

  async function save(another: boolean) {
    setBusy(another ? 'another' : 'close');
    const body = {
      title: form.title.trim(),
      type: form.type,
      priority: form.priority,
      dueAt: dueDate?.toISOString() ?? null,
      repeat: form.repeatOn && dueDate ? form.repeat : null,
      assigneeId: form.assigneeId,
      queue: form.queue,
      reminderAt: reminderDate?.toISOString() ?? null,
      description: form.description || null,
      contactId: contacts[0]?.id ?? null,
      companyId: company?.id ?? null,
      dealId: deal?.id ?? null,
    };
    try {
      if (task) await api.patch(`/tasks/${task.id}`, body);
      else await api.post('/tasks', body);
      await Promise.all([...recordKeys, keys.tasks].map((queryKey) => qc.invalidateQueries({queryKey})));
      toast.success(task ? 'Task updated' : 'Task created');
      if (another) {
        // Keep the associations, start a fresh task.
        setForm({...blank(), assigneeId: form.assigneeId, queue: form.queue});
        f.reset();
      } else onClose();
    } catch (e) {
      f.fail(e);
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent size="md">
        <form {...f.form(() => save(false))} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{task ? 'Edit task' : 'Create task'}</DialogTitle>
            {defaults?.label && !task && <DialogDescription>For {defaults.label}</DialogDescription>}
          </DialogHeader>
          <DialogBody className="gap-5">
            <Field label="Task title *" htmlFor="t-title" error={f.error('title')}>
              <Input id="t-title" autoFocus value={form.title} onChange={(e) => setForm({...form, title: e.target.value})} onBlur={f.blur('title')} placeholder="e.g. Follow up on pricing" />
            </Field>

            <div className="grid gap-1.5">
              <Label htmlFor="t-due">Due date</Label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_130px]">
                <NativeSelect id="t-due" value={form.preset} onChange={(e) => pickPreset(e.target.value)}>
                  {presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  <option value="custom">Custom date</option>
                  <option value="none">No due date</option>
                </NativeSelect>
                <Input aria-label="Due time" type="time" value={form.time} disabled={form.preset === 'none'} onChange={(e) => setForm({...form, time: e.target.value})} />
              </div>
              {form.preset === 'custom' && (
                <>
                  <Input
                    aria-label="Due date"
                    type="date"
                    value={form.date}
                    onChange={(e) => setForm({...form, date: e.target.value})}
                    onBlur={f.blur('date')}
                    aria-invalid={f.invalid('date') || undefined}
                    aria-describedby={f.invalid('date') ? 't-date-error' : undefined}
                  />
                  {f.error('date') && <p id="t-date-error" role="alert" className="text-xs font-medium text-destructive">{f.error('date')}</p>}
                </>
              )}
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{dueDate ? dueDate.toLocaleString('en-US', {dateStyle: 'medium', timeStyle: 'short'}) : 'No due date'}</span>
                <button type="button" className="cursor-pointer font-semibold text-primary hover:underline" onClick={() => setForm({...form, preset: 'bd3', date: toDateInput(addBusinessDays(3).toISOString()), time: '08:00'})}>Reset</button>
              </div>
            </div>

            <div className="grid gap-2">
              <div className="flex items-center gap-2">
                <Checkbox id="t-repeat" checked={form.repeatOn} disabled={!dueDate} onCheckedChange={(v) => setForm({...form, repeatOn: v === true})} />
                <Label htmlFor="t-repeat" className="inline-flex items-center gap-1.5 font-medium"><Repeat className="size-3.5 text-slate-400" /> Set to repeat</Label>
              </div>
              {form.repeatOn && dueDate && (
                <div className="pl-6">
                  <NativeSelect aria-label="Repeat" value={form.repeat} onChange={(e) => setForm({...form, repeat: e.target.value})}>
                    {REPEAT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </NativeSelect>
                  <p className="mt-1 text-xs text-muted-foreground">Completing it schedules the next one automatically.</p>
                </div>
              )}
            </div>

            <Field label="Assigned to" htmlFor="t-assignee">
              <UserSelect id="t-assignee" value={form.assigneeId} onChange={(v) => setForm({...form, assigneeId: v})} />
            </Field>

            <div className="grid gap-1.5">
              <Label>Task type</Label>
              <div className="flex flex-wrap gap-1.5">
                {(Object.keys(TASK_TYPES) as TaskType[]).map((t) => {
                  const Icon = TASK_ICONS[t];
                  return (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={form.type === t}
                      onClick={() => setForm({...form, type: t})}
                      className={cn(
                        'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-all',
                        form.type === t ? 'border-transparent bg-brand text-white shadow-btn' : 'border-border bg-card text-slate-600 hover:border-slate-300',
                      )}
                    >
                      <Icon className="size-3.5" /> {TASK_TYPES[t]}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-2 rounded-xl border border-slate-100 bg-slate-50/60 p-3">
              <p className="text-sm font-semibold text-slate-700">Associate task with <span className="font-normal text-muted-foreground">· {associated} record{associated === 1 ? '' : 's'}</span></p>
              <div className="grid gap-2">
                <div className="grid grid-cols-[18px_minmax(0,1fr)] items-center gap-2"><User className="size-4 text-slate-400" /><ContactsPicker value={contacts} onChange={(v) => setContacts(v.slice(-1))} /></div>
                <div className="grid grid-cols-[18px_minmax(0,1fr)] items-center gap-2"><Building2 className="size-4 text-slate-400" /><CompanyPicker value={company} onChange={setCompany} /></div>
                <div className="grid grid-cols-[18px_minmax(0,1fr)] items-center gap-2"><Handshake className="size-4 text-slate-400" /><DealPicker value={deal} onChange={setDeal} /></div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Priority" htmlFor="t-priority">
                <div className="relative">
                  <span className={cn('pointer-events-none absolute top-1/2 left-3 size-2 -translate-y-1/2 rounded-full', PRIORITIES.find((p) => p[0] === form.priority)?.[2])} />
                  <NativeSelect id="t-priority" className="pl-7" value={form.priority} onChange={(e) => setForm({...form, priority: e.target.value as Priority})}>
                    {PRIORITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </NativeSelect>
                </div>
              </Field>
              <Field label="Queue" htmlFor="t-queue">
                <CreatableSelect id="t-queue" noun="queue" placeholder="None" value={form.queue} options={settings.data?.settings.taskQueues ?? []} onChange={(v) => setForm({...form, queue: v as string | null})} onCreate={() => {}} />
              </Field>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="t-reminder">Reminder</Label>
              <NativeSelect id="t-reminder" value={form.reminder} onChange={(e) => setForm({...form, reminder: e.target.value, reminderAt: e.target.value === 'custom' ? form.reminderAt || (dueDate ? localStamp(new Date(dueDate.getTime() - 3600_000)) : '') : ''})}>
                {REMINDERS.map(([v, l]) => <option key={v} value={v} disabled={!dueDate && v !== 'none' && v !== 'custom'}>{l}</option>)}
              </NativeSelect>
              {form.reminder === 'custom' && (
                <>
                  <Input
                    aria-label="Reminder date and time"
                    type="datetime-local"
                    value={form.reminderAt}
                    onChange={(e) => setForm({...form, reminderAt: e.target.value})}
                    onBlur={f.blur('reminderAt')}
                    aria-invalid={f.invalid('reminderAt') || undefined}
                    aria-describedby={f.invalid('reminderAt') ? 't-reminder-error' : undefined}
                  />
                  {f.error('reminderAt') && <p id="t-reminder-error" role="alert" className="text-xs font-medium text-destructive">{f.error('reminderAt')}</p>}
                </>
              )}
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{reminderDate ? `You'll get a reminder in the app ${reminderDate.toLocaleString('en-US', {dateStyle: 'medium', timeStyle: 'short'})}` : 'No reminder set'}</span>
                {form.reminder !== 'none' && <button type="button" className="cursor-pointer font-semibold text-slate-500 hover:text-slate-800" onClick={() => setForm({...form, reminder: 'none', reminderAt: ''})}>Clear</button>}
              </div>
            </div>

            <Field label="Task notes" htmlFor="t-notes" error={f.error('description')}>
              <Textarea id="t-notes" rows={6} value={form.description} onChange={(e) => setForm({...form, description: e.target.value})} placeholder="Context, talking points, links…" />
            </Field>
          </DialogBody>
          <DialogFooter className="@sm:justify-start">
            <Button type="submit" disabled={!!busy} pending={busy === 'close'} pendingLabel={task ? 'Saving…' : 'Creating…'}>{task ? 'Save task' : 'Create task'}</Button>
            {!task && (
              <Button type="button" variant="secondary" disabled={!!busy} pending={busy === 'another'} pendingLabel="Creating…" onClick={() => f.submit(() => save(true))()}>
                Create and add another
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={onClose} disabled={!!busy}>Cancel</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
