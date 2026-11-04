import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {type FormEvent, type ReactNode, useId, useRef, useState} from 'react';

import {Button} from '@/components/ui/button';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Checkbox, Input, Label, Textarea} from '@/components/ui/form';
import {Skeleton} from '@/components/ui/misc';
import {type PermissionRow, type RoleRow, roleFieldErrors, siteAccessQuery, siteApi, SiteApiError, siteKeys, sitePermissionsQuery} from '@/lib/site-admin';

import {canDelegate, grants} from '../../../platform/auth/codenames';
import {ErrorNote, PendingButton} from './common';

type Values = {slug: string; name: string; description: string};
type FieldName = keyof Values;

/** Label, control, then the error (or hint) under it, tied to the control for screen readers. */
function FormField({id, label, hint, error, optional, children}: {id: string; label: string; hint?: string; error?: string; optional?: boolean; children: ReactNode}) {
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={id}>
        {label}
        {optional && <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}
      </Label>
      {children}
      {error ? (
        <p id={`${id}-msg`} className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-msg`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Create a site role (`POST /site-api/admin/roles`) or edit one (`PATCH /site-api/admin/roles/:slug`),
 * both site:role:update. You can only give a role permissions you hold yourself: the server refuses
 * anything else, and the boxes for codenames you do not hold are off here.
 */
export function RoleDialog({role, onClose, onSaved}: {role: RoleRow | null; onClose: () => void; onSaved: (name: string) => void}) {
  const ids = useId();
  const qc = useQueryClient();
  const catalogue = useQuery(sitePermissionsQuery);
  const access = useQuery(siteAccessQuery);
  const held = new Set(access.data?.permissions ?? []);
  const creating = role === null;

  const [values, setValues] = useState<Values>({slug: role?.slug ?? '', name: role?.name ?? '', description: role?.description ?? ''});
  const [picked, setPicked] = useState<string[]>(role?.permissions ?? []);
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [serverFields, setServerFields] = useState<Record<string, string>>({});
  const refs = {slug: useRef<HTMLInputElement>(null), name: useRef<HTMLInputElement>(null), description: useRef<HTMLTextAreaElement>(null)};

  const errors = roleFieldErrors(values, creating);
  const errorOf = (name: FieldName): string | undefined => serverFields[name] ?? (touched[name] || submitted ? errors[name] : undefined);

  const save = useMutation({
    mutationFn: () =>
      creating
        ? siteApi.post('/admin/roles', {slug: values.slug.trim().toLowerCase(), name: values.name.trim(), description: values.description.trim(), permissions: picked})
        : siteApi.patch(`/admin/roles/${encodeURIComponent(role.slug)}`, {name: values.name.trim(), description: values.description.trim(), permissions: picked}),
    onSuccess: async () => {
      await qc.invalidateQueries({queryKey: siteKeys.roles});
      onSaved(values.name.trim());
    },
    onError: (e) => {
      if (e instanceof SiteApiError && Object.keys(e.fields).length) {
        setServerFields(e.fields);
        const first = (['slug', 'name', 'description'] as const).find((n) => e.fields[n]);
        if (first) refs[first].current?.focus();
      }
    },
  });

  const set = (name: FieldName, value: string) => {
    setValues((v) => ({...v, [name]: value}));
    setServerFields(({[name]: _gone, ...rest}) => rest);
  };
  const control = (name: FieldName) => {
    const id = `${ids}-${name}`;
    const error = errorOf(name);
    return {
      id,
      name,
      value: values[name],
      'aria-invalid': error ? true : undefined,
      'aria-describedby': `${id}-msg`,
      onBlur: () => setTouched((t) => ({...t, [name]: true})),
      disabled: save.isPending,
    };
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    setSubmitted(true);
    const first = (['slug', 'name', 'description'] as const).find((n) => errors[n]);
    if (first) {
      refs[first].current?.focus();
      return;
    }
    setServerFields({});
    save.mutate();
  };

  const permissions = catalogue.data?.permissions ?? [];
  const groups = [...new Set(permissions.map((p) => p.group))];
  // Editing a role that holds something you lack: the server refuses any change to it.
  const beyondYou = !creating && access.data !== undefined && !canDelegate(held, role.permissions);
  const otherError = save.error && !(save.error instanceof SiteApiError && ['slug', 'name', 'description', 'permissions'].some((n) => (save.error as SiteApiError).fields[n]));

  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent size="md">
        <form noValidate onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{creating ? 'New role' : `Edit ${role.name}`}</DialogTitle>
            <DialogDescription>You can only give a role permissions you hold yourself.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {beyondYou && (
              <p role="status" className="rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
                This role allows things you do not hold yourself, so you cannot change it.
              </p>
            )}
            {creating && (
              <FormField id={`${ids}-slug`} label="Id" hint="Lowercase, used in code, like “editor”. It cannot change later." error={errorOf('slug')}>
                <Input ref={refs.slug} {...control('slug')} autoComplete="off" maxLength={48} placeholder="editor" onChange={(e) => set('slug', e.target.value)} />
              </FormField>
            )}
            <FormField id={`${ids}-name`} label="Name" error={errorOf('name')}>
              <Input ref={refs.name} {...control('name')} autoComplete="off" maxLength={80} placeholder="Editor" onChange={(e) => set('name', e.target.value)} />
            </FormField>
            <FormField id={`${ids}-description`} label="Description" optional error={errorOf('description')}>
              <Textarea ref={refs.description} {...control('description')} rows={2} maxLength={255} className="min-h-16" onChange={(e) => set('description', e.target.value)} />
            </FormField>

            <ErrorNote error={catalogue.error ?? access.error} onRetry={() => (void catalogue.refetch(), void access.refetch())} />
            {catalogue.isPending || access.isPending ? (
              <div className="grid gap-2">{Array.from({length: 4}, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
            ) : (
              groups.map((group) => (
                <fieldset key={group} className="grid gap-2" disabled={save.isPending || beyondYou}>
                  <legend className="mb-2 text-sm font-semibold text-slate-700">{group}</legend>
                  {permissions
                    .filter((p) => p.group === group)
                    .map((p) => (
                      <PermissionBox
                        key={p.codename}
                        id={`${ids}-p-${p.codename}`}
                        permission={p}
                        checked={picked.includes(p.codename)}
                        // Unticking is always allowed; ticking only what you hold.
                        allowed={grants(held, p.codename) || picked.includes(p.codename)}
                        onChange={(v) => setPicked((cur) => (v ? [...cur, p.codename] : cur.filter((c) => c !== p.codename)))}
                      />
                    ))}
                </fieldset>
              ))
            )}
            {serverFields.permissions && (
              <p role="alert" className="text-sm font-medium text-destructive">
                {serverFields.permissions}
              </p>
            )}
            {otherError && <ErrorNote error={save.error} />}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <PendingButton type="submit" pending={save.isPending} pendingLabel="Saving…" disabled={beyondYou || catalogue.isPending}>
              {creating ? 'Create role' : 'Save changes'}
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PermissionBox({id, permission: p, checked, allowed, onChange}: {id: string; permission: PermissionRow; checked: boolean; allowed: boolean; onChange: (v: boolean) => void}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-100 p-3 hover:bg-slate-50 has-[button:disabled]:cursor-not-allowed has-[button:disabled]:opacity-60">
      <Checkbox id={id} className="mt-0.5" checked={checked} disabled={!allowed} onCheckedChange={(v) => onChange(v === true)} />
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-slate-900">{p.title}</span>
        {p.description && <span className="block text-xs text-muted-foreground">{p.description}</span>}
        <code className="mt-0.5 block text-[11px] text-muted-foreground">{p.codename}</code>
        {!allowed && <span className="block text-xs font-medium text-amber-700">You do not hold this permission, so you cannot give it.</span>}
      </span>
    </label>
  );
}
