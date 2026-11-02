import {Link} from '@tanstack/react-router';
import {AlarmClock, CheckCircle2, ClipboardList, Inbox, Lock, Mail, MessageCircle, Send, Settings, ShieldAlert, Trash2, User, UserX} from 'lucide-react';

import {CHANNEL_FILTERS, INBOX_FOLDERS, INBOX_VIEWS, type ChannelFilter, type InboxView} from '@/lib/inbox';
import {useMe} from '@/lib/queries';
import type {InboxCounts} from '@/lib/types';
import {cn} from '@/lib/utils';

import {NativeSelect} from '../ui/form';

const VIEW_ICONS: Record<InboxView, typeof Inbox> = {unassigned: UserX, mine: User, open: Inbox, snoozed: AlarmClock, closed: CheckCircle2, sent: Send, spam: ShieldAlert, trash: Trash2};
const CHANNEL_ICONS: Record<ChannelFilter, typeof Inbox> = {team: Mail, personal: Lock, form: ClipboardList, chat: MessageCircle};

export type NavValue = {view: InboxView; channel?: ChannelFilter};

function Item({icon: Icon, label, count, active, onClick}: {icon: typeof Inbox; label: string; count?: number; active: boolean; onClick: () => void}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn('flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm font-medium transition-colors', active ? 'bg-accent text-primary' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900')}
    >
      <Icon className={cn('size-4 shrink-0', active ? 'text-primary' : 'text-slate-400')} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {!!count && <span className={cn('text-xs font-semibold tabular-nums', active ? 'text-primary' : 'text-slate-400')}>{count}</span>}
    </button>
  );
}

const Heading = ({children}: {children: string}) => <p className="mt-4 mb-1 px-2.5 text-[11px] font-bold tracking-wide text-slate-400 uppercase first:mt-0">{children}</p>;

/** Left navigation: views, channels with counts, folders and (for admins) the settings link. */
export function InboxNav({value, counts, onChange}: {value: NavValue; counts: InboxCounts | undefined; onChange: (v: NavValue) => void}) {
  const {isAdmin} = useMe();
  const channels = (Object.keys(CHANNEL_FILTERS) as ChannelFilter[]).filter((k) => k !== 'team' || counts?.teamAccess !== false);
  return (
    <nav aria-label="Inbox" className="flex h-full flex-col overflow-y-auto p-3 scrollbar-thin">
      <Heading>Views</Heading>
      {(Object.keys(INBOX_VIEWS) as (keyof typeof INBOX_VIEWS)[]).map((v) => (
        <Item key={v} icon={VIEW_ICONS[v]} label={INBOX_VIEWS[v]} count={counts?.views[v]} active={value.view === v && !value.channel} onClick={() => onChange({view: v})} />
      ))}
      <Heading>Channels</Heading>
      {channels.map((ch) => (
        <Item key={ch} icon={CHANNEL_ICONS[ch]} label={CHANNEL_FILTERS[ch]} count={counts?.channels[ch]} active={value.channel === ch} onClick={() => onChange({view: 'open', channel: ch})} />
      ))}
      <Heading>Folders</Heading>
      {(Object.keys(INBOX_FOLDERS) as (keyof typeof INBOX_FOLDERS)[]).map((v) => (
        <Item key={v} icon={VIEW_ICONS[v]} label={INBOX_FOLDERS[v]} count={v === 'sent' ? undefined : counts?.folders[v]} active={value.view === v && !value.channel} onClick={() => onChange({view: v})} />
      ))}
      {isAdmin && (
        <Link to="/settings/inbox" className="mt-auto flex items-center gap-2.5 rounded-lg px-2.5 py-2 pt-4 text-sm font-medium text-slate-500 hover:text-primary">
          <Settings className="size-4 text-slate-400" /> Inbox settings
        </Link>
      )}
    </nav>
  );
}

/** The same choices as one select, for narrow screens. */
export function InboxNavSelect({value, counts, onChange}: {value: NavValue; counts: InboxCounts | undefined; onChange: (v: NavValue) => void}) {
  const current = value.channel ? `ch:${value.channel}` : value.view;
  const n = (c?: number) => (c ? ` (${c})` : '');
  return (
    <NativeSelect aria-label="Inbox view" className="h-9" value={current} onChange={(e) => onChange(e.target.value.startsWith('ch:') ? {view: 'open', channel: e.target.value.slice(3) as ChannelFilter} : {view: e.target.value as InboxView})}>
      <optgroup label="Views">
        {(Object.keys(INBOX_VIEWS) as (keyof typeof INBOX_VIEWS)[]).map((v) => <option key={v} value={v}>{INBOX_VIEWS[v]}{n(counts?.views[v])}</option>)}
      </optgroup>
      <optgroup label="Channels">
        {(Object.keys(CHANNEL_FILTERS) as ChannelFilter[]).filter((k) => k !== 'team' || counts?.teamAccess !== false).map((ch) => <option key={ch} value={`ch:${ch}`}>{CHANNEL_FILTERS[ch]}{n(counts?.channels[ch])}</option>)}
      </optgroup>
      <optgroup label="Folders">
        {(Object.keys(INBOX_FOLDERS) as (keyof typeof INBOX_FOLDERS)[]).map((v) => <option key={v} value={v}>{INBOX_FOLDERS[v]}{v === 'sent' ? '' : n(counts?.folders[v])}</option>)}
      </optgroup>
    </NativeSelect>
  );
}
