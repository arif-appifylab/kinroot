import {useNavigate} from '@tanstack/react-router';
import {useState} from 'react';

import {api} from '@/lib/api';
import {keys, recordKeys, useApiMutation, useMe} from '@/lib/queries';
import {TICKET_PRIORITIES, type TicketPriority} from '@/lib/tickets';
import type {CompanyLite, ContactLite, TicketRow} from '@/lib/types';

import {RichEditor} from '../email-editor';
import {CompanyPicker, ContactsPicker, DealPicker, UserSelect} from '../pickers';
import {Button} from '../ui/button';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '../ui/dialog';
import {Field, Input, NativeSelect} from '../ui/form';
import {is, useFormState} from '../ui/form-state';
import {useTicketSettings} from './ticket-badges';

export type TicketDefaults = {contact?: ContactLite | null; company?: CompanyLite | null; deal?: {id: string; title: string} | null};

export function NewTicketDialog({defaults = {}, onClose}: {defaults?: TicketDefaults; onClose: () => void}) {
  const {me} = useMe();
  const navigate = useNavigate();
  const settings = useTicketSettings();
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [contacts, setContacts] = useState<ContactLite[]>(defaults.contact ? [defaults.contact] : []);
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState<CompanyLite | null>(defaults.company ?? null);
  const [deal, setDeal] = useState<{id: string; title: string} | null>(defaults.deal ?? null);
  const [priority, setPriority] = useState<TicketPriority>('NORMAL');
  const [category, setCategory] = useState('');
  const [queue, setQueue] = useState('');
  const [assigneeId, setAssigneeId] = useState<string | null>(me.id);
  const s = settings.data?.settings;

  const create = useApiMutation(
    () =>
      api.post<{ticket: TicketRow}>('/tickets', {
        subject,
        descriptionHtml: description,
        contactId: contacts[0]?.id ?? null,
        email: contacts[0] ? null : email || null,
        companyId: company?.id ?? null,
        dealId: deal?.id ?? null,
        priority,
        category: category || null,
        queue: queue || null,
        assigneeId,
      }),
    {
      invalidate: [keys.tickets, ...recordKeys],
      success: (r) => `Ticket #${r.ticket.number} created`,
      onSuccess: (r) => (onClose(), navigate({to: '/tickets/$ticketId', params: {ticketId: String(r.ticket.number)}})),
    },
  );

  const f = useFormState(
    {subject, email},
    {
      subject: [is.required('Enter a subject, like "Refund for order 1042".'), is.maxLength(300)],
      email: [is.email()],
    },
  );

  return (
    <Dialog open onOpenChange={(o) => !o && !create.isPending && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>New ticket</DialogTitle>
          <DialogDescription>Log a request that came in by phone, chat or in person.</DialogDescription>
        </DialogHeader>
        <form {...f.form(() => create.mutate(undefined, {onError: f.fail}))} className="contents">
          <DialogBody>
            <Field label="Subject" htmlFor="t-subject" error={f.error('subject')}>
              <Input id="t-subject" autoFocus value={subject} onChange={(e) => setSubject(e.target.value)} onBlur={f.blur('subject')} placeholder="What does the customer need?" />
            </Field>
            <Field label="Description">
              <RichEditor variant="text" compact minHeight={110} value={description} onChange={setDescription} ariaLabel="Description" placeholder="Details, steps to reproduce, order numbers…" />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Contact" htmlFor="t-contact">
                <ContactsPicker id="t-contact" value={contacts} onChange={(v) => setContacts(v.slice(-1))} />
              </Field>
              {!contacts.length && (
                <Field label="…or their email" htmlFor="t-email" hint="Creates the contact if it's new." error={f.error('email')}>
                  <Input id="t-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={f.blur('email')} placeholder="name@company.com" />
                </Field>
              )}
              <Field label="Company" htmlFor="t-company" hint={contacts.length ? "Defaults to the contact's company." : undefined}>
                <CompanyPicker id="t-company" value={company} onChange={setCompany} />
              </Field>
              <Field label="Deal" htmlFor="t-deal">
                <DealPicker id="t-deal" value={deal} onChange={setDeal} />
              </Field>
              <Field label="Priority" htmlFor="t-priority">
                <NativeSelect id="t-priority" value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
                  {TICKET_PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </NativeSelect>
              </Field>
              <Field label="Assignee" htmlFor="t-assignee">
                <UserSelect id="t-assignee" value={assigneeId} onChange={setAssigneeId} />
              </Field>
              <Field label="Category" htmlFor="t-category">
                <NativeSelect id="t-category" value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">No category</option>
                  {s?.categories.map((c) => <option key={c}>{c}</option>)}
                </NativeSelect>
              </Field>
              <Field label="Queue" htmlFor="t-queue">
                <NativeSelect id="t-queue" value={queue} onChange={(e) => setQueue(e.target.value)}>
                  <option value="">No queue</option>
                  {s?.queues.map((q) => <option key={q}>{q}</option>)}
                </NativeSelect>
              </Field>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={create.isPending}>Cancel</Button>
            <Button type="submit" pending={create.isPending} pendingLabel="Creating…">Create ticket</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
