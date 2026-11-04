import {useQuery} from '@tanstack/react-query';
import {createFileRoute, Link, useNavigate} from '@tanstack/react-router';
import {format, isToday, isTomorrow} from 'date-fns';
import {CalendarCheck2, CalendarClock, CalendarDays, CalendarX2, Code2, Copy, ExternalLink, Link2, MoreHorizontal, Pencil, Plus, Trash2, Users, Video} from 'lucide-react';
import {useState} from 'react';
import {z} from 'zod';

import {copyText as copy, useBookingLinks, useCalendarState} from '@/components/booking/hooks';
import {LoadError} from '@/components/data-table';
import {MEETING_TYPES, type MeetingType} from '@/components/activity-log';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {confirm} from '@/components/ui/confirm';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Field, Input, Switch, Textarea} from '@/components/ui/form';
import {is, useFormState} from '@/components/ui/form-state';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip} from '@/components/ui/menu';
import {Avatar, EmptyState, IconBadge, PageHeader, Skeleton, Tabs, TabsList, TabsTrigger} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {fullName} from '@/lib/format';
import {keys, useApiMutation, useMe} from '@/lib/queries';
import {durationLabel} from '@/lib/scheduling';
import type {BookingLinkRow, MeetingRow} from '@/lib/types';
import {cn} from '@/lib/utils';

const TABS = ['upcoming', 'past', 'links'] as const;

export const Route = createFileRoute('/_app/meetings/')({
  validateSearch: z.object({tab: z.enum(TABS).optional()}),
  head: () => ({meta: [{title: pageTitle('Meetings')}]}),
  component: MeetingsPage,
});

function CalendarStatus() {
  const cal = useCalendarState();
  if (cal.isLoading) return null;
  const conns = cal.data?.connections ?? [];
  const broken = conns.find((c) => c.status === 'ERROR');
  if (!conns.length) {
    return (
      <Link to="/settings/calendar" className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:underline">
        <CalendarX2 className="size-3.5" /> Connect your calendar
      </Link>
    );
  }
  return (
    <Link to="/settings/calendar" className={cn('inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold hover:underline', broken ? 'bg-rose-50 text-rose-700' : 'bg-green-50 text-green-700')}>
      {broken ? <CalendarX2 className="size-3.5" /> : <CalendarCheck2 className="size-3.5" />}
      {broken ? `${broken.email} needs attention` : conns.length === 1 ? `${conns[0]!.provider === 'google' ? 'Google' : 'Outlook'} Calendar · ${conns[0]!.email}` : `${conns.length} calendars connected`}
    </Link>
  );
}

function MeetingsPage() {
  const {tab = 'upcoming'} = Route.useSearch();
  const navigate = useNavigate();
  const {canEdit} = useMe();
  const [creating, setCreating] = useState(false);
  return (
    <div>
      <PageHeader
        title="Meetings"
        description="Every meeting on the timeline, plus booking links people use to pick a time with you."
        actions={
          <>
            <CalendarStatus />
            {canEdit && <Button onClick={() => setCreating(true)}><Plus /> New booking link</Button>}
          </>
        }
      />
      <Tabs value={tab} onValueChange={(v) => navigate({to: '/meetings', search: {tab: v as (typeof TABS)[number]}})}>
        <TabsList className="mb-5">
          <TabsTrigger value="upcoming"><CalendarClock /> Upcoming</TabsTrigger>
          <TabsTrigger value="past"><CalendarDays /> Past</TabsTrigger>
          <TabsTrigger value="links"><Link2 /> Booking links</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'links' ? <LinksTab onCreate={() => setCreating(true)} /> : <MeetingsList key={tab} when={tab} />}
      {creating && <NewLinkDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

// ─── Meetings ───

const dayLabel = (d: Date) => (isToday(d) ? 'Today' : isTomorrow(d) ? 'Tomorrow' : format(d, 'EEEE, MMMM d'));

function MeetingsList({when}: {when: 'upcoming' | 'past'}) {
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const q = useQuery({
    queryKey: [...keys.scheduling, 'meetings', when, scope],
    queryFn: () => api.get<{rows: MeetingRow[]}>('/scheduling/meetings', {when, scope}),
    select: (d) => d.rows,
  });
  const rows = q.data ?? [];
  const groups: {day: string; rows: MeetingRow[]}[] = [];
  for (const r of rows) {
    const day = dayLabel(new Date(r.occurredAt));
    if (groups.at(-1)?.day !== day) groups.push({day, rows: []});
    groups.at(-1)!.rows.push(r);
  }
  return (
    <div className="grid gap-4">
      <div className="inline-flex w-fit rounded-lg bg-slate-100 p-0.5">
        {(['mine', 'all'] as const).map((s) => (
          <button key={s} type="button" aria-pressed={scope === s} onClick={() => setScope(s)} className={cn('cursor-pointer rounded-md px-3 py-1 text-xs font-semibold transition-all outline-none focus-visible:ring-2 focus-visible:ring-primary/30', scope === s ? 'bg-card text-slate-900 shadow-soft' : 'text-slate-500')}>
            {s === 'mine' ? 'My meetings' : 'Everyone'}
          </button>
        ))}
      </div>
      {q.isLoading && <Card className="grid gap-3 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</Card>}
      {q.isError && (
        <Card>
          <LoadError error={q.error} onRetry={() => q.refetch()} />
        </Card>
      )}
      {!q.isLoading && !q.isError && !rows.length && (
        <Card>
          <EmptyState
            icon={<CalendarClock />}
            title={when === 'upcoming' ? 'No upcoming meetings' : 'No past meetings yet'}
            description={when === 'upcoming' ? 'Schedule one from a contact or deal, or share a booking link so people can pick a time.' : 'Meetings you log or that get booked show up here.'}
            action={when === 'upcoming' && <Button variant="secondary" asChild><Link to="/meetings" search={{tab: 'links'}}><Link2 /> Booking links</Link></Button>}
          />
        </Card>
      )}
      {groups.map((g) => (
        <section key={g.day}>
          <h2 className="mb-2 text-xs font-bold tracking-wide text-slate-500 uppercase">{g.day}</h2>
          <Card className="divide-y divide-slate-100 overflow-hidden">
            {g.rows.map((m) => <MeetingItem key={m.id} m={m} showHost={scope === 'all'} />)}
          </Card>
        </section>
      ))}
    </div>
  );
}

function MeetingItem({m, showHost}: {m: MeetingRow; showHost: boolean}) {
  const {me, isAdmin} = useMe();
  const [canceling, setCanceling] = useState(false);
  const start = new Date(m.occurredAt);
  const end = new Date(start.getTime() + (m.durationMin ?? 30) * 60_000);
  const type = m.locationType ? MEETING_TYPES[m.locationType as MeetingType] : null;
  const canceled = m.outcome === 'Canceled' || m.booking?.status === 'CANCELED';
  const upcoming = start.getTime() > Date.now();
  const link = m.location && /^https?:\/\//.test(m.location) ? m.location : null;
  const mine = m.authorId === me.id || isAdmin;
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
      <div className="w-32 shrink-0 text-sm font-semibold text-slate-900 tabular-nums">
        {format(start, 'h:mm a')} <span className="font-normal text-muted-foreground">– {format(end, 'h:mm a')}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className={cn('truncate text-sm font-semibold text-slate-900', canceled && 'text-muted-foreground line-through')}>{m.title || 'Meeting'}</p>
          {m.booking && <Badge tone="violet"><Link2 /> {m.booking.linkName ?? 'Booked online'}</Badge>}
          {canceled && <Badge tone="rose">Canceled</Badge>}
          {m.onCalendar && (
            <Tooltip content="On the organiser's calendar">
              <span><CalendarCheck2 className="size-3.5 text-green-600" aria-label="On calendar" /></span>
            </Tooltip>
          )}
        </div>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {m.contact && <Link to="/contacts/$contactId" params={{contactId: m.contact.id}} className="font-medium text-primary hover:underline">{fullName(m.contact)}</Link>}
          {m.company && <Link to="/companies/$companyId" params={{companyId: m.company.id}} className="hover:underline">{m.company.name}</Link>}
          {m.deal && <Link to="/deals/$dealId" params={{dealId: m.deal.id}} className="hover:underline">{m.deal.title}</Link>}
          {type && <span>{type.label}</span>}
          {showHost && m.author && <span className="inline-flex items-center gap-1"><Avatar name={m.author.name} color={m.author.color} src={m.author.avatarUrl} size="xs" className="ring-0" /> {m.author.name}</span>}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {link && upcoming && !canceled && (
          <Button asChild size="sm" variant="soft"><a href={link} target="_blank" rel="noopener noreferrer"><Video /> Join</a></Button>
        )}
        {m.booking && upcoming && !canceled && mine && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Booking options"><MoreHorizontal /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => copy(m.booking!.manageUrl, 'Reschedule link copied')}><Copy /> Copy reschedule link</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => setCanceling(true)}><CalendarX2 /> Cancel booking</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {canceling && m.booking && <CancelDialog bookingId={m.booking.id} name={m.booking.name} onClose={() => setCanceling(false)} />}
    </div>
  );
}

function CancelDialog({bookingId, name, onClose}: {bookingId: string; name: string; onClose: () => void}) {
  const [reason, setReason] = useState('');
  const cancel = useApiMutation(() => api.post(`/scheduling/bookings/${bookingId}/cancel`, {reason: reason || undefined}), {
    invalidate: [keys.scheduling, keys.timeline],
    success: `Canceled · ${name} has been told`,
    onSuccess: onClose,
  });
  const f = useFormState({reason}, {reason: [is.maxLength(1000)]});
  return (
    <Dialog open onOpenChange={(o) => !o && !cancel.isPending && onClose()}>
      <DialogContent size="sm">
        <form {...f.form(() => cancel.mutate(undefined, {onError: f.fail}))} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>Cancel this booking?</DialogTitle>
            <DialogDescription>{name} gets a cancellation email and the calendar event is removed.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field label="Reason (optional)" hint="Included in the email." error={f.error('reason')}>
              <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} onBlur={f.blur('reason')} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={cancel.isPending}>Keep it</Button>
            <Button type="submit" variant="destructive" pending={cancel.isPending} pendingLabel="Canceling…">Cancel booking</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Booking links ───

function LinksTab({onCreate}: {onCreate: () => void}) {
  const {canEdit} = useMe();
  const links = useBookingLinks();
  const rows = links.data ?? [];
  if (links.isError && !links.data) {
    return (
      <Card>
        <LoadError error={links.error} onRetry={() => links.refetch()} />
      </Card>
    );
  }
  if (links.isLoading) return <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-44" />)}</div>;
  if (!rows.length) {
    return (
      <Card>
        <EmptyState
          icon={<Link2 />}
          title="No booking links yet"
          description="Create a link with your available hours, share it, and people book a time that's free on your calendar."
          action={canEdit && <Button onClick={onCreate}><Plus /> Create a booking link</Button>}
        />
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {rows.map((l) => <LinkCard key={l.id} link={l} />)}
    </div>
  );
}

function LinkCard({link: l}: {link: BookingLinkRow}) {
  const navigate = useNavigate();
  const [embed, setEmbed] = useState(false);
  const toggle = useApiMutation((active: boolean) => api.patch(`/scheduling/links/${l.id}`, {active}), {invalidate: [keys.scheduling]});
  const remove = useApiMutation(() => api.del(`/scheduling/links/${l.id}`), {invalidate: [keys.scheduling], success: 'Booking link deleted'});
  const type = MEETING_TYPES[l.locationType as MeetingType];
  return (
    <Card className={cn('flex flex-col', !l.active && 'opacity-70')}>
      <div className="flex items-start gap-3 p-5 pb-3">
        <IconBadge tone={l.kind === 'team' ? 'teal' : 'violet'}>{l.kind === 'team' ? <Users /> : <CalendarClock />}</IconBadge>
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold text-slate-900">{l.name}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {l.durations.map(durationLabel).join(' / ')} · {type?.label ?? 'Meeting'}{l.kind === 'team' ? ` · ${l.hostIds.length} in rotation` : ''}
          </p>
        </div>
        {l.canEdit && <Switch checked={l.active} disabled={toggle.isPending} aria-busy={toggle.isPending || undefined} onCheckedChange={(v) => toggle.mutate(v)} aria-label={l.active ? `Turn off ${l.name}` : `Turn on ${l.name}`} />}
      </div>
      <p className="mx-5 truncate rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs text-slate-600">{l.url.replace(/^https?:\/\//, '')}</p>
      <div className="mt-auto flex items-center gap-1.5 p-4 pt-3">
        <Button size="sm" variant="secondary" onClick={() => copy(l.url, 'Link copied')}><Copy /> Copy link</Button>
        <Button size="icon-sm" variant="ghost" asChild aria-label="Open booking page"><a href={l.url} target="_blank" rel="noopener noreferrer"><ExternalLink /></a></Button>
        <Button size="icon-sm" variant="ghost" onClick={() => setEmbed(true)} aria-label="Share on a website"><Code2 /></Button>
        <span className="ml-auto text-xs text-muted-foreground">{l.bookingCount} booked</span>
        {l.canEdit && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Options for ${l.name}`} pending={remove.isPending}><MoreHorizontal /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => navigate({to: '/meetings/links/$linkId', params: {linkId: l.id}})}><Pencil /> Edit</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={async () => (await confirm({title: `Delete "${l.name}"?`, description: `Booked meetings stay on the timeline.`, confirmLabel: 'Delete', destructive: true})) && remove.mutate(undefined)}><Trash2 /> Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {l.canEdit && (
        <Link to="/meetings/links/$linkId" params={{linkId: l.id}} className="border-t border-slate-100 px-5 py-2.5 text-center text-xs font-semibold text-primary hover:bg-slate-50">
          Edit availability & settings
        </Link>
      )}
      {embed && <EmbedDialog link={l} onClose={() => setEmbed(false)} />}
    </Card>
  );
}

function Snippet({code, label}: {code: string; label: string}) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-xl bg-slate-950 p-4 pr-12 text-xs leading-relaxed text-slate-200 scrollbar-thin">{code}</pre>
      <Button size="icon-sm" variant="ghost" className="absolute top-2 right-2 text-muted-foreground hover:bg-white/10 hover:text-white" onClick={() => copy(code, `${label} copied`)} aria-label={`Copy ${label}`}>
        <Copy />
      </Button>
    </div>
  );
}

function EmbedDialog({link, onClose}: {link: BookingLinkRow; onClose: () => void}) {
  // Other websites can't show this site inside their pages (X-Frame-Options: DENY): they link to it.
  const button = `<a href="${link.url}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 20px;border-radius:12px;background:#2563eb;color:#fff;font:600 15px/1.2 system-ui,sans-serif;text-decoration:none">Book a meeting</a>`;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Share “{link.name}”</DialogTitle>
          <DialogDescription>Send the link, or add a booking button to any website.</DialogDescription>
        </DialogHeader>
        <DialogBody className="gap-5">
          <Field label="Direct link" group><Snippet code={link.url} label="Link" /></Field>
          <Field label="Button on a website" group hint="It opens the booking page. Other websites can't show this site inside their own page."><Snippet code={button} label="Button code" /></Field>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function NewLinkDialog({onClose}: {onClose: () => void}) {
  const navigate = useNavigate();
  const {isAdmin} = useMe();
  const [name, setName] = useState('Intro call');
  const [kind, setKind] = useState<'personal' | 'team'>('personal');
  const create = useApiMutation(
    () => api.post<{link: {id: string}}>('/scheduling/links', {name: name.trim(), kind, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone}),
    {invalidate: [keys.scheduling], onSuccess: (r) => navigate({to: '/meetings/links/$linkId', params: {linkId: r.link.id}})},
  );
  const f = useFormState({name}, {name: [is.required('Give the meeting a name, like Intro call.'), is.maxLength(120)]});
  return (
    <Dialog open onOpenChange={(o) => !o && !create.isPending && onClose()}>
      <DialogContent size="md">
        <form {...f.form(() => create.mutate(undefined, {onError: f.fail}))} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>New booking link</DialogTitle>
            <DialogDescription>Weekdays 9–5 to start with; set your hours next.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field label="Meeting name" htmlFor="nl-name" error={f.error('name')}>
              <Input id="nl-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={f.blur('name')} maxLength={120} autoFocus />
            </Field>
            {isAdmin && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Who people book with">
                {([
                  ['personal', 'Just me', 'People book time with you.', CalendarClock],
                  ['team', 'Team round robin', 'Rotates among the people you pick.', Users],
                ] as const).map(([k, title, text, Icon]) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={kind === k}
                    onClick={() => setKind(k)}
                    className={cn('cursor-pointer rounded-xl border p-3 text-left transition-all outline-none focus-visible:ring-2 focus-visible:ring-primary/30', kind === k ? 'border-primary bg-primary/[0.06] ring-1 ring-primary' : 'border-slate-200 hover:border-primary/50')}
                  >
                    <Icon className="size-4 text-primary" />
                    <p className="mt-1.5 text-sm font-semibold text-slate-900">{title}</p>
                    <p className="text-xs text-muted-foreground">{text}</p>
                  </button>
                ))}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={create.isPending}>Cancel</Button>
            <Button type="submit" pending={create.isPending} pendingLabel="Creating…">Create link</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
