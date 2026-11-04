import {useMutation, useQueryClient} from '@tanstack/react-query';
import {createFileRoute, Link} from '@tanstack/react-router';
import {Camera, ShieldCheck, Trash2} from 'lucide-react';
import {useRef, useState} from 'react';
import {toast} from 'sonner';

import {EmailSection} from '@/components/account/email-section';
import {OwnerAccessNote} from '@/components/account/owner-note';
import {FormError, FormField, PendingButton, useForm} from '@/components/account/form';
import {SettingsSection} from '@/components/settings-section';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/form';
import {Avatar} from '@/components/ui/misc';
import {accountApi, AccountError, accountKeys} from '@/lib/account-api';
import {api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {keys, useApiMutation, useMe} from '@/lib/queries';
import {uploadFile} from '@/lib/upload';
import {cn} from '@/lib/utils';
import {AUTH_RULES} from '../../../lib/rules';

export const Route = createFileRoute('/_app/settings/profile')({
  head: () => ({meta: [{title: pageTitle('Profile')}]}),
  component: ProfileSettings,
});

const COLORS = ['#2563eb', '#0d9488', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0891b2', '#475569'];

/**
 * Settings → Profile: your picture, colour and name, and the email address you sign in with.
 * The name is the site account's (`PATCH /site-api/auth/me`); Kinroot keeps a copy in its
 * `Member` row with the colour (`PATCH /site-api/crm/auth/me`). Password, two-step sign-in,
 * devices and deleting the account are in Settings → Security.
 */
function ProfileSettings() {
  const {me} = useMe();
  if (me.accountOwner) {
    return (
      <div>
        <ProfileSection />
        <OwnerAccessNote />
      </div>
    );
  }
  return (
    <div>
      <ProfileSection />
      <EmailSection />
      <SettingsSection title="Password and sign-in" description="Your password, two-step sign-in, signed-in devices and deleting your account.">
        <Button asChild variant="secondary">
          <Link to="/settings/security">
            <ShieldCheck /> Open security settings
          </Link>
        </Button>
      </SettingsSection>
    </div>
  );
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
  const pick = (file?: File) => {
    if (picker.current) picker.current.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return toast.error('Pictures can be up to 2 MB');
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
            <p className="text-xs text-muted-foreground">PNG, JPEG, WebP or GIF, up to 2 MB. Without a picture your initials show on this colour:</p>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Avatar colour">
              {COLORS.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} onClick={() => setColor(c)} className={cn('size-6 cursor-pointer rounded-full transition-transform hover:scale-110', color === c && 'ring-2 ring-offset-2 ring-slate-900')} style={{background: c}} />
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
