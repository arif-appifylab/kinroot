import {ArrowLeft, Loader2, Paperclip, Send} from 'lucide-react';
import {useState} from 'react';

import {RichEditor} from '@/components/email-editor';
import {PublicCard} from '@/components/public-layout';
import {RichText} from '@/components/rich-text';
import {CustomerStatus, PortalNav, SignInPrompt, usePortal, type PortalSession} from '@/components/tickets/portal';
import {PublicPage} from './public-page';
import {Button} from '@/components/ui/button';
import {Field} from '@/components/ui/form';
import {useFormState} from '@/components/ui/form-state';
import {Avatar} from '@/components/ui/misc';
import {api} from '@/lib/api';
import type {Brand} from '@/lib/brand';
import {isEmptyHtml} from '@/lib/email-html';
import {dateTime} from '@/lib/format';
import {STATUS, type TicketStatus} from '@/lib/tickets';
import {useBrand} from '@/lib/use-brand';
import {cn} from '@/lib/utils';

type PortalTicket = {
  number: number;
  subject: string;
  description: string | null;
  descriptionHtml: string | null;
  status: TicketStatus;
  createdAt: string;
  messages: {id: string; kind: 'reply' | 'event'; fromCustomer: boolean; author: string; body: string; html: string | null; status: TicketStatus | null; files: {name: string; size: number; url: string}[]; createdAt: string}[];
};
type Data = {session: PortalSession | null; ticket: PortalTicket | null};

/** /support/tickets/<number>: one request, its public replies, and a reply box (src/pages/support/tickets/[number].astro). */
export default function SupportRequestPage({brand, number}: {brand: Brand; number: string}) {
  return (
    <PublicPage brand={brand}>
      <PortalTicketPage number={number} />
    </PublicPage>
  );
}

function PortalTicketPage({number}: {number: string}) {
  const brand = useBrand();
  const {data, setData, error} = usePortal<Data>(`/public/support/tickets/${number}`);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // The server's "write a message first" (`fields.html`) shows under the editor.
  const f = useFormState({html: body});

  if (error) return <PublicCard><p className="text-sm font-medium text-destructive">{error}</p></PublicCard>;
  if (!data) return <PublicCard className="flex justify-center"><Loader2 className="size-5 animate-spin text-primary" /></PublicCard>;
  if (!data.session) return <PublicCard><SignInPrompt title="Sign in to see this request" intro="Use the email address you contacted us from." /></PublicCard>;
  if (!data.ticket) {
    return (
      <>
        <PortalNav session={data.session} />
        <PublicCard className="text-center sm:mt-4">
          <h1 className="text-xl font-extrabold tracking-tight text-slate-900">Request not found</h1>
          <p className="mt-2 text-sm text-muted-foreground">It may belong to a different email address.</p>
        </PublicCard>
      </>
    );
  }
  const ticket = data.ticket;

  async function reply() {
    setBusy(true);
    setSendError(null);
    try {
      const r = await api.post<{ticket: PortalTicket}>(`/public/support/tickets/${ticket.number}/reply`, {html: body});
      setData({...data!, ticket: r.ticket});
      setBody('');
    } catch (e) {
      if (!f.fail(e)) setSendError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PortalNav session={data.session} />
      <PublicCard className="max-w-2xl sm:mt-4">
        <a href="/support/tickets/" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-primary"><ArrowLeft className="size-4" /> My requests</a>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-bold text-muted-foreground">#{ticket.number} · opened {dateTime(ticket.createdAt)}</p>
            <h1 className="mt-0.5 text-xl font-extrabold tracking-tight text-slate-900">{ticket.subject}</h1>
          </div>
          <CustomerStatus status={ticket.status} />
        </div>

        <ol className="mt-6 grid gap-3">
          {ticket.description && (
            <li className="rounded-xl border border-slate-100 bg-slate-50/60 p-4">
              <p className="mb-1.5 text-xs font-semibold text-slate-500">You wrote</p>
              <RichText html={ticket.descriptionHtml}>{ticket.description}</RichText>
            </li>
          )}
          {ticket.messages.map((m) =>
            m.kind === 'event' ? (
              <li key={m.id} className="px-1 text-center text-xs text-muted-foreground">
                Status changed to <span className="font-semibold text-slate-700">{m.status ? STATUS[m.status].customer : '—'}</span> · {dateTime(m.createdAt)}
              </li>
            ) : (
              <li key={m.id} className={cn('rounded-xl border p-4', m.fromCustomer ? 'border-slate-100 bg-slate-50/60' : 'border-blue-100 bg-blue-50/40')}>
                <p className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                  <Avatar name={m.fromCustomer ? m.author : brand.name} size="xs" className="ring-0" />
                  <span className="font-semibold text-slate-800">{m.fromCustomer ? 'You' : `${m.author} · ${brand.name}`}</span> · {dateTime(m.createdAt)}
                </p>
                <RichText html={m.html}>{m.body}</RichText>
                {m.files.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {m.files.map((f) => (
                      <a key={f.url} href={f.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-card px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:text-primary">
                        <Paperclip className="size-3.5" /> {f.name}
                      </a>
                    ))}
                  </div>
                )}
              </li>
            ),
          )}
        </ol>

        {ticket.status === 'CLOSED' ? (
          <p className="mt-6 rounded-xl bg-slate-50 px-4 py-3 text-sm text-muted-foreground">
            This request is closed. <a href="/support/" className="font-semibold text-primary hover:underline">Open a new one</a> if you need more help.
          </p>
        ) : (
          <form ref={f.ref} noValidate onSubmit={(e) => (e.preventDefault(), !isEmptyHtml(body) && !busy && reply())} className="mt-6 grid gap-2.5">
            <Field error={f.error('html')}>
            <RichEditor
              variant="text"
              compact
              minHeight={110}
              value={body}
              onChange={setBody}
              onSubmit={() => !isEmptyHtml(body) && !busy && reply()}
              ariaLabel="Your reply"
              placeholder={ticket.status === 'RESOLVED' ? 'Still need help? Reply and we will reopen your request.' : 'Write a reply…'}
            />
            </Field>
            {sendError && <p role="alert" className="text-sm font-medium text-destructive">{sendError}</p>}
            <div className="flex justify-end">
              <Button type="submit" disabled={isEmptyHtml(body)} pending={busy} pendingLabel="Sending…"><Send /> Send reply</Button>
            </div>
          </form>
        )}
      </PublicCard>
    </>
  );
}
