import {useNavigate} from '@tanstack/react-router';
import {Filter, List} from 'lucide-react';
import {useState} from 'react';

import {api} from '@/lib/api';
import {keys, useApiMutation} from '@/lib/queries';
import {emptyRules} from '@/lib/segments';
import type {ContactListRow, ListKind} from '@/lib/types';
import {cn} from '@/lib/utils';

import {Button} from '../ui/button';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '../ui/dialog';
import {Field, Input, Textarea} from '../ui/form';
import {is, useFormState} from '../ui/form-state';

const KINDS: {kind: ListKind; icon: typeof List; title: string; text: string}[] = [
  {kind: 'STATIC', icon: List, title: 'Static list', text: 'You decide who is in it: add people by hand, in bulk, by import or from forms.'},
  {kind: 'DYNAMIC', icon: Filter, title: 'Segment', text: 'Saved filter rules. Members update by themselves as contacts change.'},
];

/** Create a list (pick static or segment) or rename / describe an existing one. */
export function ListDialog({list, onClose}: {list?: Pick<ContactListRow, 'id' | 'name' | 'description' | 'kind'>; onClose: () => void}) {
  const navigate = useNavigate();
  const [kind, setKind] = useState<ListKind>(list?.kind ?? 'STATIC');
  const [name, setName] = useState(list?.name ?? '');
  const [description, setDescription] = useState(list?.description ?? '');
  const save = useApiMutation(
    () =>
      list
        ? api.patch<{list: {id: string}}>(`/lists/${list.id}`, {name: name.trim(), description})
        : api.post<{list: {id: string}}>('/lists', {name: name.trim(), description, kind, ...(kind === 'DYNAMIC' ? {rules: emptyRules()} : {})}),
    {
      invalidate: [keys.lists],
      success: list ? 'List saved' : undefined,
      onSuccess: (r) => {
        onClose();
        if (!list) navigate({to: '/lists/$listId', params: {listId: r.list.id}, search: kind === 'DYNAMIC' ? {edit: true} : {}});
      },
    },
  );

  const f = useFormState({name, description}, {
    name: [is.required('Give the list a name.'), is.maxLength(120)],
    description: [is.maxLength(5000)],
  });

  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent size="md">
        <form {...f.form(() => save.mutate(undefined, {onError: f.fail}))} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{list ? 'Edit list' : 'New list'}</DialogTitle>
            <DialogDescription>{list ? 'Rename it or say what it is for.' : 'Group contacts for follow-ups, campaigns and reports.'}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {!list && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {KINDS.map((k) => (
                  <button
                    key={k.kind}
                    type="button"
                    onClick={() => setKind(k.kind)}
                    aria-pressed={kind === k.kind}
                    className={cn('cursor-pointer rounded-xl border p-3 text-left transition-all', kind === k.kind ? 'border-primary bg-primary/[0.06] ring-1 ring-primary' : 'border-slate-200 hover:border-primary/50')}
                  >
                    <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-900"><k.icon className="size-4 text-primary" /> {k.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{k.text}</p>
                  </button>
                ))}
              </div>
            )}
            <Field label="Name" error={f.error('name')}>
              <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={f.blur('name')} maxLength={120} placeholder={kind === 'DYNAMIC' ? 'e.g. Engaged leads, last 30 days' : 'e.g. Newsletter, Event attendees'} autoFocus />
            </Field>
            <Field label="Description (optional)" error={f.error('description')}>
              <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} onBlur={f.blur('description')} className="min-h-16" />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
            <Button type="submit" pending={save.isPending} pendingLabel={list ? 'Saving…' : 'Creating…'}>
              {list ? 'Save' : kind === 'DYNAMIC' ? 'Create and add rules' : 'Create list'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
