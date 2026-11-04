import {useQuery} from '@tanstack/react-query';
import {Loader2} from 'lucide-react';

import type {Ending, PublicForm} from '@/lib/forms';

import {FormRenderer} from './renderer';

/**
 * Drop a published form into any page of this app, e.g. an AI-built landing page:
 *
 *   import {CrmForm} from '@/components/forms/crm-form';
 *   <CrmForm slug="demo-request" />
 *
 * Submissions create/update contacts exactly like the hosted form at /f/<slug>.
 */
export function CrmForm({slug, className, onSubmitted}: {slug: string; className?: string; onSubmitted?: (ending: Ending) => void}) {
  const q = useQuery({
    queryKey: ['public-form', slug],
    queryFn: async () => {
      const res = await fetch(`/site-api/crm/public/forms/${encodeURIComponent(slug)}`);
      if (!res.ok) throw new Error(res.status === 404 ? 'Form not found' : 'Could not load the form');
      return ((await res.json()) as {form: PublicForm}).form;
    },
    staleTime: 60_000,
    retry: 1,
  });
  if (q.isLoading) return <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>;
  if (!q.data) return <p className="py-6 text-center text-sm text-muted-foreground">{(q.error as Error | null)?.message ?? 'Form unavailable'}</p>;
  return <FormRenderer form={q.data} className={className} onSubmitted={onSubmitted} />;
}
