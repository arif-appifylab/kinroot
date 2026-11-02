import {Eye, KeyRound, Loader2, Trash2} from 'lucide-react';
import {useState} from 'react';

import {STEP_TYPES, TARGETS, targetLabel, WEEKDAY_SHORT, type AssigneeMode, type AutoObject, type Problem, type RecordField, type Step, type Target} from '@/lib/automations';
import {api} from '@/lib/api';
import {isEmptyHtml, textToEditorHtml} from '@/lib/email-html';
import {useEmailAccounts, usePipelines, useTeam, useTemplates} from '@/lib/queries';
import {TICKET_PRIORITIES} from '@/lib/tickets';
import {cn} from '@/lib/utils';

import {EmailPreview, RichEditor, Segmented} from '../email-editor';
import {useLists} from '../lists/list-picker';
import {TagSelect, UserSelect, type TagEntity} from '../pickers';
import {useTicketSettings} from '../tickets/ticket-badges';
import {Button} from '../ui/button';
import {Checkbox, Field, Input, Label, NativeSelect, Textarea} from '../ui/form';
import {IconBadge} from '../ui/misc';
import {ConditionsEditor} from './conditions-editor';
import {useRecordFields, useRecordOptions} from './hooks';
import {MergeMenu, STEP_ICONS, UserChips} from './meta';
import {useDateFields} from './trigger-panel';
import {WEBHOOK_SERVICE_NAMES} from '@/lib/webhook-targets';

type Props = {step: Step; object: AutoObject; onChange: (s: Step) => void};

/** Side panel for one step: its settings, problems and delete. */
export function StepPanel({step, object, onChange, onDelete, problems, readOnly, automationId, isAdmin}: Props & {onDelete: () => void; problems: Problem[]; readOnly?: boolean; automationId: string; isAdmin: boolean}) {
  const meta = STEP_TYPES[step.type];
  const {icon: Icon, tone} = STEP_ICONS[step.type];
  return (
    <div className="grid gap-5">
      <div className="flex items-start gap-3">
        <IconBadge tone={tone}><Icon /></IconBadge>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold text-slate-900">{meta.label}</h3>
          <p className="text-xs text-muted-foreground">{meta.description}</p>
        </div>
        {!readOnly && <Button variant="ghost" size="icon-sm" className="text-slate-400 hover:text-destructive" onClick={onDelete} aria-label="Delete step"><Trash2 /></Button>}
      </div>
      {problems.length > 0 && (
        <ul className="grid gap-1 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-medium text-amber-800">
          {problems.map((p, i) => <li key={i}>• {p.message}</li>)}
        </ul>
      )}
      <div className={cn('grid gap-4', readOnly && 'pointer-events-none opacity-80')}>
        <StepFields step={step} object={object} onChange={onChange} automationId={automationId} isAdmin={isAdmin} />
      </div>
    </div>
  );
}

function StepFields(props: Props & {automationId: string; isAdmin: boolean}) {
  const {step} = props;
  switch (step.type) {
    case 'if':
      return (
        <Field label="Conditions" hint="Matching records take the Yes branch, the others the No branch.">
          <ConditionsEditor object={props.object} value={step.conditions} onChange={(conditions) => props.onChange({...step, conditions})} emptyText="Add the record to check, then its rules." />
        </Field>
      );
    case 'update_field':
      return <UpdateField {...props} />;
    case 'assign_owner':
      return <AssignOwner {...props} />;
    case 'create_task':
      return <CreateTask {...props} />;
    case 'create_deal':
      return <CreateDeal {...props} />;
    case 'create_ticket':
      return <CreateTicket {...props} />;
    case 'add_tag':
    case 'remove_tag':
      return (
        <>
          <TargetSelect {...props} />
          <Field label="Tag" hint={step.type === 'add_tag' ? 'Pick a tag in use, or type a new one to create it.' : undefined}>
            <TagSelect value={step.tag} onChange={(tag) => props.onChange({...step, tag})} entity={TAG_ENTITY[step.target ?? TARGETS[props.object][0] ?? 'contact']} />
          </Field>
        </>
      );
    case 'add_to_list':
    case 'remove_from_list':
      return <ListStep {...props} />;
    case 'send_email':
      return <SendEmail {...props} />;
    case 'notify':
      return <Notify {...props} />;
    case 'webhook':
      return <WebhookStep {...props} />;
    case 'wait':
      return <Wait {...props} />;
    case 'stop':
      return <p className="text-sm text-slate-600">The run ends here; later steps in this branch don't run.</p>;
  }
}

// ─── Shared bits ────────────────────────────────────────────────────────────

/** Which records' tags to suggest for a tag step. */
const TAG_ENTITY: Record<Target, TagEntity> = {contact: 'CONTACT', company: 'COMPANY', deal: 'DEAL', ticket: 'TICKET'};

function TargetSelect({step, object, onChange, label = 'Record'}: Props & {label?: string}) {
  return (
    <Field label={label}>
      <NativeSelect value={step.target ?? ''} onChange={(e) => onChange({...step, target: e.target.value as Target, field: undefined, value: ''})}>
        {TARGETS[object].map((t) => <option key={t} value={t}>{targetLabel(object, t)}</option>)}
      </NativeSelect>
    </Field>
  );
}

function TextWithMerge({label, value, onChange, placeholder, multiline, hint, list}: {label: string; value: string; onChange: (v: string) => void; placeholder?: string; multiline?: boolean; hint?: string; list?: string}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label>{label}</Label>
        <MergeMenu onPick={(t) => onChange(`${value}${value && !value.endsWith(' ') ? ' ' : ''}${t}`)} />
      </div>
      {multiline ? <Textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="min-h-20" /> : <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} list={list} />}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

const ASSIGNEES: {value: AssigneeMode; label: string}[] = [
  {value: 'owner', label: 'The record owner'},
  {value: 'assignee', label: 'The ticket assignee'},
  {value: 'creator', label: 'Whoever created this automation'},
  {value: 'user', label: 'A specific person'},
  {value: 'none', label: 'Nobody'},
];

function AssigneePicker({step, object, onChange, label, allowNone = true}: Props & {label: string; allowNone?: boolean}) {
  const options = ASSIGNEES.filter((a) => (a.value !== 'assignee' || object === 'ticket') && (allowNone || a.value !== 'none'));
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label={label}>
        <NativeSelect value={step.assignee ?? 'owner'} onChange={(e) => onChange({...step, assignee: e.target.value as AssigneeMode})}>
          {options.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
        </NativeSelect>
      </Field>
      {step.assignee === 'user' && (
        <Field label="Person">
          <UserSelect value={step.userId} onChange={(userId) => onChange({...step, userId})} allowNone={false} />
        </Field>
      )}
    </div>
  );
}

// ─── Steps ──────────────────────────────────────────────────────────────────

function ValueInput({field, step, onChange}: {field: RecordField; step: Step; onChange: (s: Step) => void}) {
  const options = useRecordOptions()(field.options, field.choices);
  const v = step.value;
  if (field.kind === 'date') {
    return (
      <div className="grid gap-3">
        <Field label="Set to">
          <NativeSelect value={step.mode ?? 'set'} onChange={(e) => onChange({...step, mode: e.target.value as Step['mode'], value: '', days: e.target.value === 'relative' ? 7 : undefined})}>
            <option value="set">A date</option>
            <option value="relative">N days from when the step runs</option>
            {!field.required && <option value="clear">Empty (clear it)</option>}
          </NativeSelect>
        </Field>
        {(step.mode ?? 'set') === 'set' && <Input type="date" value={typeof v === 'string' ? v : ''} onChange={(e) => onChange({...step, value: e.target.value})} aria-label="Date" />}
        {step.mode === 'relative' && (
          <span className="flex items-center gap-2 text-sm text-slate-600">
            <Input type="number" className="w-24" value={step.days ?? 0} onChange={(e) => onChange({...step, days: Math.round(Number(e.target.value) || 0)})} aria-label="Days" /> days from now
          </span>
        )}
      </div>
    );
  }
  const clearOption = !field.required && (
    <label className="flex items-center gap-2 text-xs text-slate-600">
      <Checkbox checked={step.mode === 'clear'} onCheckedChange={(c) => onChange({...step, mode: c === true ? 'clear' : 'set', value: c === true ? null : ''})} /> Clear the field instead
    </label>
  );
  if (step.mode === 'clear') return <>{clearOption}</>;
  if (field.kind === 'bool') {
    return (
      <Field label="New value">
        <NativeSelect value={v === true || v === 'true' ? 'true' : 'false'} onChange={(e) => onChange({...step, value: e.target.value === 'true'})}>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </NativeSelect>
      </Field>
    );
  }
  if (field.kind === 'choice' || (field.kind === 'tags' && options.length)) {
    return (
      <>
        <Field label="New value">
          <NativeSelect value={typeof v === 'string' ? v : ''} onChange={(e) => onChange({...step, value: e.target.value})}>
            <option value="">Pick…</option>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </NativeSelect>
        </Field>
        {clearOption}
      </>
    );
  }
  if (field.kind === 'number') {
    return (
      <>
        <Field label="New value"><Input type="number" value={typeof v === 'number' || typeof v === 'string' ? v : ''} onChange={(e) => onChange({...step, value: e.target.value === '' ? '' : Number(e.target.value)})} /></Field>
        {clearOption}
      </>
    );
  }
  const id = `opts-${step.id}`;
  return (
    <>
      <TextWithMerge label="New value" value={typeof v === 'string' ? v : ''} onChange={(value) => onChange({...step, value})} placeholder="Text, merge fields allowed" list={options.length ? id : undefined} />
      {options.length > 0 && <datalist id={id}>{options.map((o) => <option key={o.value} value={o.value} />)}</datalist>}
      {clearOption}
    </>
  );
}

function UpdateField(props: Props) {
  const {step, onChange} = props;
  const target = step.target ?? TARGETS[props.object][0] ?? 'contact';
  const fields = useRecordFields(target).filter((f) => f.writable);
  const field = fields.find((f) => f.key === step.field);
  return (
    <>
      <TargetSelect {...props} label="Record to update" />
      <Field label="Field">
        <NativeSelect value={step.field ?? ''} onChange={(e) => onChange({...step, target, field: e.target.value, value: '', mode: 'set', days: undefined})}>
          <option value="">Pick a field…</option>
          {fields.map((f) => <option key={f.key} value={f.key}>{f.label}{f.key.startsWith('custom.') ? ' (custom)' : ''}</option>)}
        </NativeSelect>
      </Field>
      {field && <ValueInput field={field} step={{...step, target}} onChange={onChange} />}
      {target === 'ticket' && <p className="text-xs text-muted-foreground">Ticket status, priority and assignee changes keep SLA deadlines, the ticket thread and notifications in step.</p>}
    </>
  );
}

function AssignOwner(props: Props) {
  const {step, onChange} = props;
  const team = useTeam();
  const users = (team.data ?? []).filter((u) => u.active && u.role !== 'VIEWER');
  return (
    <>
      <TargetSelect {...props} label="Record to assign" />
      <Segmented
        label="How"
        value={step.assignMode ?? 'round_robin'}
        onChange={(assignMode) => onChange({...step, assignMode})}
        options={[{value: 'round_robin', label: 'Round robin'}, {value: 'user', label: 'A specific person'}]}
      />
      {step.assignMode === 'user' ? (
        <Field label="New owner"><UserSelect value={step.userId} onChange={(userId) => onChange({...step, userId})} allowNone={false} /></Field>
      ) : (
        <Field label="Rotate among" hint="Each run picks the next person in this order; inactive people are skipped.">
          <UserChips users={users} value={step.userIds ?? []} onChange={(userIds) => onChange({...step, userIds})} />
        </Field>
      )}
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <Checkbox checked={!!step.onlyIfEmpty} onCheckedChange={(c) => onChange({...step, onlyIfEmpty: c === true})} /> Only when the record has no owner yet
      </label>
    </>
  );
}

function CreateTask(props: Props) {
  const {step, onChange} = props;
  return (
    <>
      <TextWithMerge label="Title" value={step.title ?? ''} onChange={(title) => onChange({...step, title})} placeholder="Follow up with {{contact.full_name}}" />
      <TextWithMerge label="Description" value={step.description ?? ''} onChange={(description) => onChange({...step, description})} multiline />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Due in (days)"><Input type="number" min={0} value={step.dueDays ?? 0} onChange={(e) => onChange({...step, dueDays: Math.max(0, Math.round(Number(e.target.value) || 0))})} /></Field>
        <Field label="At" hint="Empty = no time"><Input type="time" value={step.time ?? ''} onChange={(e) => onChange({...step, time: e.target.value || null})} /></Field>
        <Field label="Type">
          <NativeSelect value={step.taskType ?? 'TODO'} onChange={(e) => onChange({...step, taskType: e.target.value})}>
            {[['TODO', 'To-do'], ['CALL', 'Call'], ['EMAIL', 'Email'], ['MEETING', 'Meeting'], ['DEADLINE', 'Deadline']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Priority">
          <NativeSelect value={step.priority ?? 'NONE'} onChange={(e) => onChange({...step, priority: e.target.value})}>
            {[['NONE', 'None'], ['LOW', 'Low'], ['NORMAL', 'Medium'], ['HIGH', 'High']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </NativeSelect>
        </Field>
      </div>
      <AssigneePicker {...props} label="Assign to" />
    </>
  );
}

function CreateDeal(props: Props) {
  const {step, onChange} = props;
  const pipelines = usePipelines();
  const pipeline = pipelines.data?.find((p) => p.id === step.pipelineId);
  return (
    <>
      <TextWithMerge label="Deal title" value={step.title ?? ''} onChange={(title) => onChange({...step, title})} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Pipeline">
          <NativeSelect value={step.pipelineId ?? ''} onChange={(e) => {
            const p = pipelines.data?.find((x) => x.id === e.target.value);
            onChange({...step, pipelineId: e.target.value, stageId: p?.stages[0]?.id ?? ''});
          }}>
            <option value="">Pick…</option>
            {pipelines.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Stage">
          <NativeSelect value={step.stageId ?? ''} onChange={(e) => onChange({...step, stageId: e.target.value})} disabled={!pipeline}>
            {pipeline?.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </NativeSelect>
        </Field>
      </div>
      <Field label="Value"><Input type="number" min={0} value={typeof step.value === 'number' ? step.value : Number(step.value) || 0} onChange={(e) => onChange({...step, value: Number(e.target.value) || 0})} /></Field>
      <AssigneePicker {...props} label="Deal owner" />
      <p className="text-xs text-muted-foreground">The new deal is linked to the run's contact and company.</p>
    </>
  );
}

function CreateTicket(props: Props) {
  const {step, onChange} = props;
  const t = useTicketSettings().data?.settings;
  return (
    <>
      <TextWithMerge label="Subject" value={step.subject ?? ''} onChange={(subject) => onChange({...step, subject})} placeholder="Onboarding: {{deal.title}}" />
      <TextWithMerge label="Description" value={step.description ?? ''} onChange={(description) => onChange({...step, description})} multiline />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Priority">
          <NativeSelect value={step.priority ?? 'NORMAL'} onChange={(e) => onChange({...step, priority: e.target.value})}>
            {TICKET_PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Category">
          <NativeSelect value={step.category ?? ''} onChange={(e) => onChange({...step, category: e.target.value})}>
            <option value="">None</option>
            {t?.categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Queue">
          <NativeSelect value={step.queue ?? ''} onChange={(e) => onChange({...step, queue: e.target.value})}>
            <option value="">None</option>
            {t?.queues.map((q) => <option key={q} value={q}>{q}</option>)}
          </NativeSelect>
        </Field>
      </div>
      <AssigneePicker {...props} label="Assignee" />
      <p className="text-xs text-muted-foreground">Linked to the run's contact, company and deal. SLA deadlines start right away.</p>
    </>
  );
}

function ListStep({step, onChange}: Props) {
  const lists = useLists('STATIC');
  return (
    <Field label="Static list" hint="The run's contact is added or removed. Segments fill themselves from their rules, so they aren't offered.">
      <NativeSelect value={step.listId ?? ''} onChange={(e) => onChange({...step, listId: e.target.value})}>
        <option value="">Pick a list…</option>
        {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </NativeSelect>
    </Field>
  );
}

function SendEmail({step, onChange}: Props) {
  const templates = useTemplates();
  const accounts = useEmailAccounts();
  const shared = (accounts.data ?? []).filter((a) => !a.userId);
  const [editorKey, setEditorKey] = useState(0);
  const [preview, setPreview] = useState(false);
  const pickTemplate = (id: string) => {
    const t = templates.data?.find((x) => x.id === id);
    if (!t) return;
    onChange({...step, templateId: id, subject: t.subject, html: t.html || textToEditorHtml(t.body), layout: t.layout === 'plain' ? 'plain' : 'branded'});
    setEditorKey((k) => k + 1);
  };
  return (
    <>
      <Field label="Start from a template">
        <NativeSelect value={step.templateId ?? ''} onChange={(e) => pickTemplate(e.target.value)}>
          <option value="">Blank</option>
          {templates.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </NativeSelect>
      </Field>
      <TextWithMerge label="Subject" value={step.subject ?? ''} onChange={(subject) => onChange({...step, subject})} />
      <div className="grid gap-1.5">
        <Label>Email</Label>
        <RichEditor key={editorKey} compact value={step.html ?? ''} onChange={(html) => onChange({...step, html})} placeholder="Write the email… merge fields are filled in per contact" />
        <p className="text-xs text-muted-foreground">Also usable as text: {'{{ticket.number}}'}, {'{{deal.stage}}'}, {'{{owner.name}}'}, {'{{record.url}}'}.</p>
      </div>
      <Segmented label="Layout" value={step.layout ?? 'branded'} onChange={(layout) => onChange({...step, layout})} options={[{value: 'branded', label: 'Branded'}, {value: 'plain', label: 'Plain'}]} />
      <Field label="Send from">
        <NativeSelect value={step.from ?? 'owner'} onChange={(e) => onChange({...step, from: e.target.value as 'owner' | 'shared', accountId: e.target.value === 'shared' ? shared[0]?.id : undefined})}>
          <option value="owner">The record owner's mailbox</option>
          <option value="shared">A shared mailbox</option>
        </NativeSelect>
      </Field>
      {step.from === 'shared' && (
        <Field label="Shared mailbox">
          <NativeSelect value={step.accountId ?? ''} onChange={(e) => onChange({...step, accountId: e.target.value})}>
            <option value="">Pick…</option>
            {shared.map((a) => <option key={a.id} value={a.id}>{a.label} · {a.fromEmail}</option>)}
          </NativeSelect>
        </Field>
      )}
      <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">One email per run, to the run's contact. Contacts who opted out or have no address are skipped (shown in the run history). It appears on the timeline and in the inbox like any email.</p>
      {!isEmptyHtml(step.html ?? '') && (
        <Button type="button" variant="secondary" size="sm" className="justify-self-start" onClick={() => setPreview(!preview)}><Eye /> {preview ? 'Hide preview' : 'Preview'}</Button>
      )}
      {preview && <EmailPreview html={step.html} subject={step.subject} layout={step.layout ?? 'branded'} height={420} />}
    </>
  );
}

function Notify(props: Props) {
  const {step, onChange} = props;
  const team = useTeam();
  const users = (team.data ?? []).filter((u) => u.active);
  return (
    <>
      <Field label="Who">
        <NativeSelect value={step.assignee ?? 'owner'} onChange={(e) => onChange({...step, assignee: e.target.value as AssigneeMode})}>
          {ASSIGNEES.filter((a) => a.value !== 'none' && (a.value !== 'assignee' || props.object === 'ticket')).map((a) => <option key={a.value} value={a.value}>{a.value === 'user' ? 'Specific people' : a.label}</option>)}
        </NativeSelect>
      </Field>
      {step.assignee === 'user' && <Field label="People"><UserChips users={users} value={step.userIds ?? []} onChange={(userIds) => onChange({...step, userIds})} /></Field>}
      <TextWithMerge label="Notification" value={step.title ?? ''} onChange={(title) => onChange({...step, title})} placeholder="{{deal.title}} needs attention" />
      <TextWithMerge label="Details" value={step.body ?? ''} onChange={(body) => onChange({...step, body})} multiline />
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <Checkbox checked={!!step.email} onCheckedChange={(c) => onChange({...step, email: c === true})} /> Also send it by email (from a shared mailbox)
      </label>
    </>
  );
}

function WebhookStep({step, onChange, automationId, isAdmin}: Props & {automationId: string; isAdmin: boolean}) {
  const [secret, setSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reveal = async () => {
    setLoading(true);
    try {
      setSecret((await api.post<{secret: string}>(`/automations/${automationId}/secret`)).secret);
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      <Field label="URL" hint={`We POST JSON with the automation, the run, the record, its related records and the trigger data. Webhooks go to ${WEBHOOK_SERVICE_NAMES}.`}>
        <Input value={step.url ?? ''} onChange={(e) => onChange({...step, url: e.target.value})} placeholder="https://hooks.zapier.com/hooks/catch/…" />
      </Field>
      <div className="grid gap-2 rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
        <p>
          Signed like Settings → Webhooks: <code>X-Webhook-Signature: t=…,v1=…</code> (HMAC-SHA256 of <code>{'"<t>.<body>"'}</code>) with this automation's signing secret. <code>X-Webhook-Id</code> is the same on retries, so receivers can ignore repeats.
        </p>
        {isAdmin && (
          secret ? <code className="break-all rounded-md bg-card px-2 py-1.5 text-slate-800">{secret}</code> : <Button type="button" variant="secondary" size="sm" className="justify-self-start" onClick={reveal} disabled={loading}>{loading ? <Loader2 className="animate-spin" /> : <KeyRound />} Show signing secret</Button>
        )}
      </div>
    </>
  );
}

function Wait(props: Props) {
  const {step, onChange, object} = props;
  const target = step.target ?? TARGETS[object][0] ?? 'contact';
  const dateFields = useDateFields(target);
  const field = dateFields.find((f) => f.key === step.field);
  return (
    <>
      <Segmented
        label="Wait"
        value={step.waitMode ?? 'duration'}
        onChange={(waitMode) => onChange({...step, waitMode, target: waitMode === 'until_date' ? target : step.target})}
        options={[{value: 'duration', label: 'For a time'}, {value: 'until_date', label: 'Until a date'}, {value: 'until_weekday', label: 'Until a weekday'}]}
      />
      {(step.waitMode ?? 'duration') === 'duration' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount"><Input type="number" min={1} value={step.amount ?? 1} onChange={(e) => onChange({...step, amount: Math.max(1, Math.round(Number(e.target.value) || 1))})} /></Field>
          <Field label="Unit">
            <NativeSelect value={step.unit ?? 'days'} onChange={(e) => onChange({...step, unit: e.target.value as Step['unit']})}>
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
              <option value="weeks">weeks</option>
            </NativeSelect>
          </Field>
        </div>
      )}
      {step.waitMode === 'until_date' && (
        <>
          <TargetSelect {...props} step={{...step, target}} onChange={(s) => onChange({...s, waitMode: 'until_date'})} />
          <Field label="Date field">
            <NativeSelect value={step.field ?? ''} onChange={(e) => onChange({...step, target, field: e.target.value})}>
              <option value="">Pick a date…</option>
              {dateFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </NativeSelect>
          </Field>
          {field?.dateOnly && <Field label="At time of day"><Input type="time" value={step.time ?? '09:00'} onChange={(e) => onChange({...step, time: e.target.value || '09:00'})} /></Field>}
          <p className="text-xs text-muted-foreground">A date already in the past, or an empty one, continues right away.</p>
        </>
      )}
      {step.waitMode === 'until_weekday' && (
        <>
          <div className="grid gap-1.5">
            <Label>Next</Label>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAY_SHORT.map((d, i) => {
                const on = (step.weekdays ?? []).includes(i);
                return (
                  <button key={d} type="button" onClick={() => onChange({...step, weekdays: on ? (step.weekdays ?? []).filter((x) => x !== i) : [...(step.weekdays ?? []), i].sort()})} className={on ? 'cursor-pointer rounded-lg border border-primary bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary' : 'cursor-pointer rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-primary/50'}>
                    {d}
                  </button>
                );
              })}
            </div>
          </div>
          <Field label="At"><Input type="time" value={step.time ?? '09:00'} onChange={(e) => onChange({...step, time: e.target.value || '09:00'})} /></Field>
        </>
      )}
      <p className="text-xs text-muted-foreground">Times use the automation's time zone (Settings tab). Waiting runs show in the run history.</p>
    </>
  );
}
