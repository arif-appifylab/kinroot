import {Link} from '@tanstack/react-router';
import {Building2, Clock, ExternalLink, Globe, Handshake, LifeBuoy, Link2, Mail, MapPin, Phone, Plus, User, UserPlus} from 'lucide-react';
import {useState} from 'react';

import {api, ApiError} from '@/lib/api';
import {visitorTime} from '@/lib/chat';
import {ago, fullName, LIFECYCLE, money} from '@/lib/format';
import {keys, useApiMutation, useMe} from '@/lib/queries';
import {STATUS, TICKET_PRIORITIES, type TicketPriority} from '@/lib/tickets';
import type {ChatVisitor, ConversationDetail} from '@/lib/types';

import {DealPicker, SingleContactPicker} from '../pickers';
import {Badge} from '../ui/badge';
import {Button} from '../ui/button';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '../ui/dialog';
import {Field, Input, NativeSelect} from '../ui/form';
import {is, useFormState} from '../ui/form-state';
import {Avatar} from '../ui/misc';

const invalidate = [keys.inbox, keys.timeline, keys.contacts, keys.deals, keys.tickets];

function Section({title, action, children}: {title: string; action?: React.ReactNode; children: React.ReactNode}) {
  return (
    <section className="border-b border-slate-100 px-4 py-4 last:border-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold tracking-wide text-slate-500 uppercase">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function ContactDrawer({detail, mode, onClose}: {detail: ConversationDetail; mode: 'create' | 'link'; onClose: () => void}) {
  const sender = detail.sidebar.sender;
  const [first, ...rest] = (sender?.name || sender?.email.split('@')[0] || '').split(/\s+/);
  const [form, setForm] = useState({firstName: first ?? '', lastName: rest.join(' '), email: sender?.email.includes('@') ? sender.email : ''});
  const [contactId, setContactId] = useState<string | null>(null);
  const save = useApiMutation(
    () => api.post(`/inbox/conversations/${detail.conversation.id}/contact`, mode === 'create' ? {create: {...form, lastName: form.lastName || null, email: form.email || null}} : {contactId}),
    {invalidate, success: mode === 'create' ? 'Contact created and linked' : 'Contact linked', onSuccess: onClose},
  );
  const f = useFormState(
    {...form, contactId},
    mode === 'create'
      ? {firstName: [is.required('Enter a first name.'), is.maxLength(100)], lastName: [is.maxLength(100)], email: [is.email()]}
      : {contactId: [is.required('Choose the contact to link.')]},
  );
  // The server names the new contact's fields `create.<field>`.
  const fail = (e: unknown) => f.fail(e instanceof ApiError ? new ApiError(e.message, e.status, Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k.replace(/^create\./, ''), v]))) : e);
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent size="sm">
        <form {...f.form(() => save.mutate(undefined, {onError: fail}))} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{mode === 'create' ? 'Create contact' : 'Link to a contact'}</DialogTitle>
            <DialogDescription>The conversation and its earlier emails move to the contact's timeline.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {mode === 'create' ? (
              <>
                <Field label="First name" htmlFor="ic-first" error={f.error('firstName')}><Input id="ic-first" value={form.firstName} onChange={(e) => setForm({...form, firstName: e.target.value})} onBlur={f.blur('firstName')} /></Field>
                <Field label="Last name" htmlFor="ic-last" error={f.error('lastName')}><Input id="ic-last" value={form.lastName} onChange={(e) => setForm({...form, lastName: e.target.value})} onBlur={f.blur('lastName')} /></Field>
                <Field label="Email" htmlFor="ic-email" error={f.error('email')}><Input id="ic-email" type="email" value={form.email} onChange={(e) => setForm({...form, email: e.target.value})} onBlur={f.blur('email')} /></Field>
              </>
            ) : (
              <Field label="Contact" error={f.error('contactId')}><SingleContactPicker onChange={setContactId} /></Field>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
            <Button type="submit" pending={save.isPending} pendingLabel={mode === 'create' ? 'Creating…' : 'Linking…'}>{mode === 'create' ? 'Create' : 'Link'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DealDrawer({detail, onClose}: {detail: ConversationDetail; onClose: () => void}) {
  const [deal, setDeal] = useState<{id: string; title: string} | null>(detail.sidebar.deal);
  const save = useApiMutation(() => api.patch(`/inbox/conversations/${detail.conversation.id}`, {dealId: deal?.id ?? null}), {invalidate, success: deal ? 'Deal associated' : 'Deal removed', onSuccess: onClose});
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent size="sm">
        <form noValidate onSubmit={(e) => (e.preventDefault(), !save.isPending && save.mutate(undefined))} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>Associate deal</DialogTitle>
            <DialogDescription>Replies from this conversation are logged on the deal too.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field label="Deal"><DealPicker value={deal} onChange={setDeal} /></Field>
            {detail.sidebar.deals.length > 0 && (
              <div className="grid gap-1.5">
                <p className="text-xs font-semibold text-slate-500">Open deals of this contact</p>
                {detail.sidebar.deals.map((d) => (
                  <button key={d.id} type="button" onClick={() => setDeal(d)} className="cursor-pointer rounded-lg border border-slate-200 px-3 py-2 text-left text-sm hover:border-primary/50">
                    <span className="font-semibold text-slate-800">{d.title}</span> <span className="text-xs text-muted-foreground">· {d.stage.name}</span>
                  </button>
                ))}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
            <Button type="submit" pending={save.isPending} pendingLabel="Saving…">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TicketDrawer({detail, onClose}: {detail: ConversationDetail; onClose: () => void}) {
  const [subject, setSubject] = useState(detail.conversation.subject);
  const [priority, setPriority] = useState<TicketPriority>('NORMAL');
  const save = useApiMutation(() => api.post<{ticket: {number: number}}>(`/inbox/conversations/${detail.conversation.id}/ticket`, {subject, priority}), {invalidate, success: (r) => `Ticket #${r.ticket.number} created`, onSuccess: onClose});
  const f = useFormState({subject}, {subject: [is.required('Enter a subject for the ticket.'), is.maxLength(300)]});
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent size="sm">
        <form {...f.form(() => save.mutate(undefined, {onError: f.fail}))} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>Create ticket</DialogTitle>
            <DialogDescription>Opens a support ticket for this contact with the latest message as its description. The conversation stays in the inbox.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field label="Subject" htmlFor="it-subject" error={f.error('subject')}><Input id="it-subject" value={subject} onChange={(e) => setSubject(e.target.value)} onBlur={f.blur('subject')} /></Field>
            <Field label="Priority" htmlFor="it-priority">
              <NativeSelect id="it-priority" value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
                {TICKET_PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </NativeSelect>
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
            <Button type="submit" pending={save.isPending} pendingLabel="Creating…">Create ticket</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const shortUrl = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/$/, '');

/** Website chat: where the visitor is and has been (from the widget), and where they came from. */
function VisitorSection({v}: {v: ChatVisitor}) {
  const [all, setAll] = useState(false);
  const pages = all ? v.pages : v.pages.slice(0, 4);
  const local = visitorTime(v.timeZone);
  const utm = Object.entries(v.utm);
  return (
    <Section title="Visitor">
      <div className="grid gap-2 text-xs text-slate-600">
        <p className="flex items-center gap-1.5 font-semibold">
          <span className={`size-2 rounded-full ${v.online ? 'bg-green-500' : 'bg-slate-300'}`} aria-hidden />
          <span className={v.online ? 'text-green-700' : 'text-slate-500'}>{v.online ? 'On the site now' : `Last seen ${ago(v.lastSeenAt)}`}</span>
          {v.blocked && <Badge tone="rose">Blocked</Badge>}
        </p>
        {v.page && (
          <a href={v.page} target="_blank" rel="noopener noreferrer" className="flex min-w-0 items-start gap-1.5 hover:text-primary">
            <Globe className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0"><span className="block truncate font-medium text-slate-800">{v.title || 'Current page'}</span><span className="block truncate">{shortUrl(v.page)}</span></span>
            <ExternalLink className="mt-0.5 size-3 shrink-0" />
          </a>
        )}
        {v.location && <p className="flex items-center gap-1.5"><MapPin className="size-3.5 shrink-0" /> {v.location}{local ? ` · ${local} there` : ''}</p>}
        <p className="flex items-center gap-1.5"><Clock className="size-3.5 shrink-0" /> First seen {ago(v.firstSeenAt)}{v.conversations > 1 ? ` · ${v.conversations} chats` : ''}</p>
        {v.referrer && <p className="truncate">Came from <a href={v.referrer} target="_blank" rel="noopener noreferrer" className="font-medium text-slate-800 hover:text-primary">{shortUrl(v.referrer)}</a></p>}
        {utm.length > 0 && (
          <div className="flex flex-wrap gap-1">{utm.map(([k, val]) => <Badge key={k} tone="neutral">{k.replace('utm_', '')}: {val}</Badge>)}</div>
        )}
        {v.pages.length > 0 && (
          <div className="grid gap-1">
            <p className="font-semibold text-slate-500">Pages viewed</p>
            <ol className="grid gap-1">
              {pages.map((p, i) => (
                <li key={`${p.url}${i}`} className="flex min-w-0 items-baseline gap-1.5">
                  <a href={p.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate hover:text-primary" title={p.url}>{p.title || shortUrl(p.url)}</a>
                  <span className="shrink-0 text-muted-foreground">{ago(p.at)}</span>
                </li>
              ))}
            </ol>
            {v.pages.length > 4 && <button type="button" className="w-fit cursor-pointer font-semibold text-primary hover:underline" onClick={() => setAll((x) => !x)}>{all ? 'Show fewer' : `Show all ${v.pages.length}`}</button>}
          </div>
        )}
      </div>
    </Section>
  );
}

/** Right sidebar: who this is, their company, open deals, tickets and recent activity. */
export function ConversationSidebar({detail}: {detail: ConversationDetail}) {
  const {canEdit} = useMe();
  const [drawer, setDrawer] = useState<'create' | 'link' | 'deal' | 'ticket' | null>(null);
  const s = detail.sidebar;
  const c = s.contact;
  const deals = [...(s.deal ? [s.deal] : []), ...s.deals.filter((d) => d.id !== s.deal?.id)];

  return (
    <div className="text-sm">
      <Section title="Contact" action={canEdit && c && <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setDrawer('link')}>Change</Button>}>
        {c ? (
          <div className="grid gap-2">
            <Link to="/contacts/$contactId" params={{contactId: c.id}} className="flex items-center gap-2.5 font-semibold text-slate-900 hover:text-primary">
              <Avatar name={fullName(c)} color="#0d9488" size="md" />
              <span className="min-w-0">
                <span className="block truncate">{fullName(c)}</span>
                {c.title && <span className="block truncate text-xs font-normal text-muted-foreground">{c.title}</span>}
              </span>
            </Link>
            <div className="flex flex-wrap gap-1">
              <Badge tone={LIFECYCLE[c.lifecycleStage].tone}>{LIFECYCLE[c.lifecycleStage].label}</Badge>
              {c.score > 0 && <Badge tone="rose">Score {c.score}</Badge>}
              {c.emailOptOut && <Badge tone="amber">Opted out</Badge>}
            </div>
            {c.email && <a href={`mailto:${c.email}`} className="flex items-center gap-1.5 truncate text-slate-600 hover:text-primary"><Mail className="size-3.5 shrink-0" /> {c.email}</a>}
            {c.phone && <a href={`tel:${c.phone}`} className="flex items-center gap-1.5 text-slate-600 hover:text-primary"><Phone className="size-3.5 shrink-0" /> {c.phone}</a>}
            {c.owner && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><User className="size-3.5" /> Owner: {c.owner.name}</p>}
          </div>
        ) : s.contactHidden ? (
          <p className="text-muted-foreground">Linked to a contact you can't see.</p>
        ) : (
          <div className="grid gap-2">
            <p className="font-semibold text-slate-800">{s.sender?.name || (detail.chat ? 'Anonymous visitor' : 'Unknown sender')}</p>
            {s.sender?.email && <p className="truncate text-xs text-muted-foreground">{s.sender.email}</p>}
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setDrawer('create')}><UserPlus /> Create contact</Button>
                <Button size="sm" variant="secondary" onClick={() => setDrawer('link')}><Link2 /> Link existing</Button>
              </div>
            )}
          </div>
        )}
      </Section>

      {detail.chat?.visitor && <VisitorSection v={detail.chat.visitor} />}

      {s.company && (
        <Section title="Company">
          <Link to="/companies/$companyId" params={{companyId: s.company.id}} className="flex items-center gap-2 font-semibold text-slate-800 hover:text-primary">
            <Building2 className="size-4 text-slate-400" /> <span className="truncate">{s.company.name}</span>
          </Link>
          {(s.company.domain || s.company.industry) && <p className="mt-0.5 truncate text-xs text-muted-foreground">{[s.company.domain, s.company.industry].filter(Boolean).join(' · ')}</p>}
        </Section>
      )}

      <Section title="Deals" action={canEdit && <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setDrawer('deal')}><Handshake /> Associate</Button>}>
        {deals.length ? (
          <ul className="grid gap-1.5">
            {deals.map((d) => (
              <li key={d.id}>
                <Link to="/deals/$dealId" params={{dealId: d.id}} className="block rounded-lg border border-slate-100 px-2.5 py-1.5 hover:border-primary/40">
                  <span className="block truncate font-semibold text-slate-800">{d.title}</span>
                  <span className="block text-xs text-muted-foreground">{money(d.value, d.currency)} · {d.stage.name}{d.id === s.deal?.id ? ' · linked' : ''}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No open deals</p>
        )}
      </Section>

      <Section title="Tickets" action={canEdit && <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setDrawer('ticket')}><Plus /> Create ticket</Button>}>
        {s.tickets.length ? (
          <ul className="grid gap-1.5">
            {s.tickets.map((t) => (
              <li key={t.id}>
                <Link to="/tickets/$ticketId" params={{ticketId: String(t.number)}} className="flex items-center gap-2 text-slate-700 hover:text-primary">
                  <LifeBuoy className="size-3.5 shrink-0 text-slate-400" />
                  <span className="min-w-0 flex-1 truncate">#{t.number} {t.subject}</span>
                  <Badge tone={STATUS[t.status].tone}>{STATUS[t.status].label}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No tickets</p>
        )}
      </Section>

      {s.activity.length > 0 && (
        <Section title="Recent activity">
          <ul className="grid gap-2">
            {s.activity.map((a) => (
              <li key={a.id} className="text-xs">
                <p className="line-clamp-2 text-slate-700">{a.title}</p>
                <p className="text-muted-foreground">{ago(a.createdAt)}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(drawer === 'create' || drawer === 'link') && <ContactDrawer detail={detail} mode={drawer} onClose={() => setDrawer(null)} />}
      {drawer === 'deal' && <DealDrawer detail={detail} onClose={() => setDrawer(null)} />}
      {drawer === 'ticket' && <TicketDrawer detail={detail} onClose={() => setDrawer(null)} />}
    </div>
  );
}
