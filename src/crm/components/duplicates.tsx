import {useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {CopyCheck, TriangleAlert} from 'lucide-react';
import {useEffect, useState} from 'react';

import {api} from '@/lib/api';
import {DUPLICATE_REASONS} from '@/lib/hygiene';
import {keys} from '@/lib/queries';
import type {DuplicateHintMatch} from '@/lib/types';
import {cn} from '@/lib/utils';

import {Button} from './ui/button';

/** Medium + high confidence open pairs (what the queue shows by default), plus how many low ones are hidden. */
export type DuplicateCounts = {contact: number; company: number; lowConfidence: {contact: number; company: number}; lastScan: {contact?: string; company?: string}; scanning?: boolean};

/** While a "Scan now" job is queued or running, asks again every 5 seconds (only then). */
export const useDuplicateCounts = () =>
  useQuery({queryKey: [...keys.duplicates, 'counts'], queryFn: () => api.get<DuplicateCounts>('/duplicates/counts'), staleTime: 60_000, refetchInterval: (q) => (q.state.data?.scanning ? 5_000 : false)});

/** "Duplicates (3)" next to the list page actions; hidden when the queue is empty. */
export function DuplicatesButton({entity}: {entity: 'contact' | 'company'}) {
  const counts = useDuplicateCounts();
  const n = counts.data?.[entity] ?? 0;
  if (!n) return null;
  return (
    <Button variant="secondary" size="sm" className="h-9" asChild>
      <Link to="/settings/duplicates" search={{entity}}><CopyCheck /> Duplicates <span className="rounded-full bg-amber-100 px-1.5 text-xs text-amber-800">{n}</span></Link>
    </Button>
  );
}

function useDebounced<T>(value: T, ms = 400) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

type HintInput =
  | {entity: 'contact'; firstName: string; lastName: string; email: string; phone: string; companyId: string | null}
  | {entity: 'company'; name: string; domain: string};

/**
 * Non-blocking "Possible duplicate" hint for the create dialogs: shows the
 * best existing matches while the user types (same scoring as the duplicate queue).
 */
export function DuplicateHint({input, onOpen, className}: {input: HintInput; onOpen: () => void; className?: string}) {
  const body = useDebounced(input);
  const enough =
    body.entity === 'contact'
      ? !!(body.email.includes('@') || body.phone.replace(/\D/g, '').length >= 7 || (body.firstName.trim() && body.lastName.trim()))
      : !!(body.domain.includes('.') || body.name.trim().length >= 3);
  const q = useQuery({
    queryKey: [...keys.duplicates, 'check', body],
    queryFn: () => api.post<{matches: DuplicateHintMatch[]}>('/duplicates/check', body),
    enabled: enough,
    staleTime: 30_000,
  });
  const matches = enough ? (q.data?.matches ?? []) : [];
  if (!matches.length) return null;
  const linkCls = 'font-semibold underline-offset-2 hover:underline';
  return (
    <div role="status" className={cn('rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm', className)}>
      <p className="flex items-center gap-2 font-semibold text-amber-800"><TriangleAlert className="size-4" /> Possible duplicate</p>
      <ul className="mt-1.5 grid gap-1">
        {matches.map((m) => (
          <li key={m.id} className="flex flex-wrap items-baseline gap-x-2 text-amber-800">
            {body.entity === 'contact' ? (
              <Link to="/contacts/$contactId" params={{contactId: m.id}} onClick={onOpen} className={linkCls}>{m.label}</Link>
            ) : (
              <Link to="/companies/$companyId" params={{companyId: m.id}} onClick={onOpen} className={linkCls}>{m.label}</Link>
            )}
            {m.detail && <span className="text-xs text-amber-700">{m.detail}</span>}
            <span className="text-xs text-amber-700">· {m.reasons.map((r) => DUPLICATE_REASONS[r] ?? r).join(', ')}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-xs text-amber-700">You can still create it; duplicates can be merged later.</p>
    </div>
  );
}
