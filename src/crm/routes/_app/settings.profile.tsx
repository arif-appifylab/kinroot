import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {createFileRoute, useRouterState} from '@tanstack/react-router';
import {Camera, Trash2} from 'lucide-react';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import {toast} from 'sonner';

import {DeleteSection} from '@/components/account/delete-section';
import {DevicesSection} from '@/components/account/devices-section';
import {EmailSection} from '@/components/account/email-section';
import {FormError, FormField, PendingButton, useForm} from '@/components/account/form';
import {OwnerAccessNote} from '@/components/account/owner-note';
import {PasswordSection} from '@/components/account/password-section';
import {TwoFactorSection} from '@/components/account/two-factor-section';
import {LoadError} from '@/components/data-table';
import {SettingsSection} from '@/components/settings-section';
import {Input} from '@/components/ui/form';
import {Avatar, Skeleton} from '@/components/ui/misc';
import {accountApi, AccountError, accountKeys, viewerQuery} from '@/lib/account-api';
import {api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {colourName} from '@/lib/colours';
import {keys, useApiMutation, useMe} from '@/lib/queries';
import {uploadFile} from '@/lib/upload';
import {cn} from '@/lib/utils';
import {AUTH_RULES} from '../../../lib/rules';

export const Route = createFileRoute('/_app/settings/profile')({
  head: () => ({meta: [{title: pageTitle('Your account')}]}),
  component: YourAccount,
});

const COLORS = ['#2563eb', '#0d9488', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0891b2', '#475569'];

/**
 * Settings → Your account (owner request, 4 Nov; it was Profile and Security): your picture, colour
 * and name; the email you sign in with; your password and two-step sign-in (`#security`); signed-in
 * devices; deleting the account. The name is the site account's (`PATCH /site-api/auth/me`); Kinroot
 * keeps a copy in its `Member` row with the colour (`PATCH /site-api/crm/auth/me`). Everything else is
 * the site's auth core (`/site-api/auth/*`, src/crm/lib/account-api.ts).
 *
 * The site owner's account has no email, password or two-step sign-in here (it comes from the
 * dashboard): they see a note instead, and their devices. The account is read before any of those
 * parts show, so the owner never sees them flash while it loads (AUDIT-2 L-17).
 */
function YourAccount() {
  const {me} = useMe();
  const viewer = useQuery(viewerQuery);
  // Held here: nothing else on the page can drop recovery codes not saved yet.
  const [codes, setCodes] = useState<string[] | null>(null);
  const owner = Boolean(me.accountOwner || viewer.data?.platformOwner);
  // The account's own email, for the "not your email address" password rule.
  const email = viewer.data?.email ?? me.email ?? '';
  useScrollToHash(!viewer.isPending);

  let signIn: ReactNode;
  if (owner) signIn = <OwnerAccessNote />;
  else if (viewer.isPending)
    signIn = (
      <div className="mb-6 grid gap-3" aria-busy="true" aria-label="Loading your sign-in settings">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    );
  else if (viewer.isError)
    signIn = (
      <SettingsSection title="Sign-in">
        <LoadError title="Your sign-in settings could not be loaded" error={viewer.error} onRetry={() => void viewer.refetch()} />
      </SettingsSection>
    );
  else
    signIn = (
      <>
        <EmailSection />
        <div id="security" className="scroll-mt-24">
          <PasswordSection email={email} />
          <TwoFactorSection codes={codes} setCodes={setCodes} />
        </div>
      </>
    );

  return (
    <div>
      <ProfileSection />
      {signIn}
      <DevicesSection />
      {!owner && viewer.isSuccess && <DeleteSection />}
    </div>
  );
}

/** An old Settings → Security link lands here with `#security`: show that part once it rendered. */
function useScrollToHash(ready: boolean) {
  const hash = useRouterState({select: (s) => s.location.hash});
  useEffect(() => {
    if (!ready || !hash) return;
    const el = document.getElementById(hash);
    if (!el) return;
    el.scrollIntoView({block: 'start'});
    el.querySelector<HTMLElement>('h2')?.setAttribute('tabindex', '-1');
    el.querySelector<HTMLElement>('h2')?.focus({preventScroll: true});
  }, [ready, hash]);
}

function ProfileSection() {
  const {me} = useMe();
  const queryClient = useQueryClient();
  const [color, setColor] = useState(me.color);
  const form = useForm('profile', {name: me.name}, {name: AUTH_RULES.name});
  const save = useMutation({
    mutationFn: async (body: {name: string; color: string}) => {
      if (body.name !== me.name) await accountApi.saveName(body.name);
      return api.patch('/auth/me', body);
    },
    onSuccess: async () => {
      await Promise.all([keys.auth, keys.team, accountKeys.viewer].map((queryKey) => queryClient.invalidateQueries({queryKey})));
      toast.success('Saved your profile.');
    },
    onError: (err) => err instanceof AccountError && form.setServerErrors(err.fields),
  });
  const picker = useRef<HTMLInputElement>(null);
  const upload = useApiMutation((file: File) => uploadFile('/auth/me/avatar', file), {invalidate: [keys.auth, keys.team], success: 'Profile picture updated'});
  const removePhoto = useApiMutation(() => api.del('/auth/me/avatar'), {invalidate: [keys.auth, keys.team], success: 'Profile picture removed'});
  const [pickError, setPickError] = useState<string | null>(null);
  const pick = (file?: File) => {
    if (picker.current) picker.current.value = '';
    setPickError(null);
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return setPickError('That picture is over 2 MB. Choose a smaller one.');
    upload.mutate(file);
  };
  const shownName = form.values.name.trim() || me.name;

  return (
    <SettingsSection title="Your profile" description="How you show to your team, on records and in mentions.">
      <form noValidate onSubmit={form.submit((values) => save.mutate({name: values.name.trim(), color}))} className="grid gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <Avatar name={shownName} color={color} src={me.avatarUrl} size="lg" className="size-16" />
          <div className="grid gap-2">
            <div className="flex flex-wrap gap-2">
              <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" aria-label="Profile picture" onChange={(e) => pick(e.target.files?.[0])} />
              <PendingButton type="button" variant="secondary" size="sm" onClick={() => picker.current?.click()} pending={upload.isPending} pendingLabel="Uploading…" disabled={removePhoto.isPending}>
                <Camera /> {me.avatarUrl ? 'Change picture' : 'Upload picture'}
              </PendingButton>
              {me.avatarUrl && (
                <PendingButton type="button" variant="ghost" size="sm" onClick={() => removePhoto.mutate(undefined)} pending={removePhoto.isPending} pendingLabel="Removing…" disabled={upload.isPending}>
                  <Trash2 /> Remove
                </PendingButton>
              )}
            </div>
            {pickError && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {pickError}
              </p>
            )}
            <p className="text-xs text-muted-foreground">PNG, JPEG, WebP or GIF, up to 2 MB. Without a picture your initials show on this colour:</p>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Avatar colour">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={color === c}
                  aria-label={colourName(c)}
                  title={colourName(c)}
                  onClick={() => setColor(c)}
                  className={cn('size-6 cursor-pointer rounded-full transition-transform outline-none hover:scale-110 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2', color === c && 'ring-2 ring-slate-900 ring-offset-2')}
                  style={{background: c}}
                />
              ))}
            </div>
          </div>
        </div>
        <FormField id={form.id('name')} label="Your name" error={form.error('name')} className="max-w-sm">
          <Input {...form.field('name')} autoComplete="name" />
        </FormField>
        <FormError error={save.error} />
        <div>
          <PendingButton type="submit" pending={save.isPending} pendingLabel="Saving…">
            Save profile
          </PendingButton>
        </div>
      </form>
    </SettingsSection>
  );
}
