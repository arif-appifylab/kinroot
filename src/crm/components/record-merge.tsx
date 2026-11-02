import {useQuery} from '@tanstack/react-query';

import {api} from '@/lib/api';
import {fullName, LIFECYCLE} from '@/lib/format';
import type {ContactLite} from '@/lib/types';

import {MergeDialog, type MergeRow} from './merge-dialog';
import {SingleCompanyPicker, SingleContactPicker} from './pickers';

/**
 * The contact and company merge dialogs, used from the record pages (pick the
 * duplicate) and from the duplicate queue (`otherId` already known).
 */
type MergeRec = {id: string; createdAt: string} & Record<string, unknown>;

const CONTACT_ROWS: MergeRow[] = [
  {field: 'firstName', label: 'First name'},
  {field: 'lastName', label: 'Last name'},
  {field: 'email', label: 'Email'},
  {field: 'phone', label: 'Phone'},
  {field: 'title', label: 'Job title'},
  {field: 'linkedin', label: 'LinkedIn'},
  {field: 'lifecycleStage', label: 'Lifecycle stage', show: (v) => LIFECYCLE[v as keyof typeof LIFECYCLE]?.label ?? String(v)},
  {field: 'leadStatus', label: 'Lead status'},
  {field: 'buyingRole', label: 'Buying role'},
  {field: 'city', label: 'City'},
  {field: 'country', label: 'Country'},
  {field: 'source', label: 'Source'},
];

const COMPANY_ROWS: MergeRow[] = [
  {field: 'name', label: 'Name'},
  {field: 'domain', label: 'Domain'},
  {field: 'industry', label: 'Industry'},
  {field: 'type', label: 'Type'},
  {field: 'employees', label: 'Employees'},
  {field: 'annualRevenue', label: 'Annual revenue'},
  {field: 'phone', label: 'Phone'},
  {field: 'city', label: 'City'},
  {field: 'country', label: 'Country'},
  {field: 'timezone', label: 'Time zone'},
  {field: 'linkedin', label: 'LinkedIn'},
];

const loadContact = (id: string) => api.get<{contact: MergeRec}>(`/contacts/${id}`).then((d) => d.contact);
const loadCompany = (id: string) => api.get<{company: MergeRec}>(`/companies/${id}`).then((d) => d.company);

/** The preselected duplicate, shown instead of the picker. */
function Preselected({noun, id, load, title}: {noun: string; id: string; load: (id: string) => Promise<MergeRec>; title: (r: MergeRec) => string}) {
  const q = useQuery({queryKey: ['merge', noun, id], queryFn: () => load(id)});
  return <p className="flex h-10 items-center rounded-lg border border-border bg-slate-50 px-3 text-sm font-semibold text-slate-800">{q.data ? title(q.data) : 'Loading…'}</p>;
}

type Props = {otherId?: string; onClose: () => void; onMerged: (keptId: string) => void};

export function ContactMergeDialog({contact, otherId, onClose, onMerged}: Props & {contact: MergeRec}) {
  const title = (r: MergeRec) => fullName(r as unknown as ContactLite);
  return (
    <MergeDialog
      noun="contact"
      current={contact}
      rows={CONTACT_ROWS}
      title={title}
      subtitle={(r) => (r.email as string | null) ?? 'No email'}
      picker={(_, set) => (otherId ? <Preselected noun="contact" id={otherId} load={loadContact} title={title} /> : <SingleContactPicker exclude={contact.id} onChange={set} />)}
      load={loadContact}
      mergeUrl={`/contacts/${contact.id}/merge`}
      notes={[
        'Notes, emails, calls, meetings, tasks, deals, companies, tickets, form responses, bookings and list memberships of both records end up on the kept record.',
        'Tags are combined; custom field values are kept, with the primary record winning conflicts.',
        'If either record opted out of email, the merged record stays opted out.',
      ]}
      initialOtherId={otherId}
      onClose={onClose}
      onMerged={onMerged}
    />
  );
}

export function CompanyMergeDialog({company, otherId, onClose, onMerged}: Props & {company: MergeRec}) {
  const title = (r: MergeRec) => String(r.name ?? '');
  return (
    <MergeDialog
      noun="company"
      current={company}
      rows={COMPANY_ROWS}
      title={title}
      subtitle={(r) => (r.domain as string | null) ?? 'No domain'}
      picker={(_, set) => (otherId ? <Preselected noun="company" id={otherId} load={loadCompany} title={title} /> : <SingleCompanyPicker exclude={company.id} onChange={set} />)}
      load={loadCompany}
      mergeUrl={`/companies/${company.id}/merge`}
      notes={[
        'The kept record keeps the chosen domain and name; other properties follow your choices.',
        'Contacts, deals, tickets, notes, emails, calls, meetings and tasks of both companies end up on the kept record.',
        'Tags are combined; custom field values are kept, with the primary record winning conflicts.',
      ]}
      initialOtherId={otherId}
      onClose={onClose}
      onMerged={onMerged}
    />
  );
}

/** Duplicate queue: loads the first record of the pair, then opens the merge dialog with the second preselected. */
export function MergePairDialog({entity, aId, bId, onClose, onMerged}: {entity: 'contact' | 'company'; aId: string; bId: string; onClose: () => void; onMerged: (keptId: string) => void}) {
  const load = entity === 'contact' ? loadContact : loadCompany;
  const q = useQuery({queryKey: ['merge', entity, aId], queryFn: () => load(aId)});
  if (!q.data) return null;
  return entity === 'contact' ? (
    <ContactMergeDialog contact={q.data} otherId={bId} onClose={onClose} onMerged={onMerged} />
  ) : (
    <CompanyMergeDialog company={q.data} otherId={bId} onClose={onClose} onMerged={onMerged} />
  );
}
