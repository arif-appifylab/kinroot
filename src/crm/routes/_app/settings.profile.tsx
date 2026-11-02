import {createFileRoute} from '@tanstack/react-router';
import {Camera, KeyRound, Loader2, Trash2} from 'lucide-react';
import {useRef, useState} from 'react';
import {toast} from 'sonner';

import {SettingsSection} from '@/components/settings-section';
import {Button} from '@/components/ui/button';
import {Field, Input} from '@/components/ui/form';
import {Avatar} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {keys, useApiMutation, useMe} from '@/lib/queries';
import {cn} from '@/lib/utils';
import {uploadFile} from '@/lib/upload';
import {siteFetch} from '../../../platform/browser';

export const Route = createFileRoute('/_app/settings/profile')({
  component: ProfileSettings,
});

const COLORS = ['#2563eb', '#0d9488', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0891b2', '#475569'];

/** The account's name, through the site's own route (the template's auth, src/platform/auth). */
async function saveAccountName(name: string) {
  const res = await siteFetch('/site-api/auth/me', {method: 'PATCH', headers: {'content-type': 'application/json'}, body: JSON.stringify({name})});
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {message?: string; fields?: Record<string, string>};
    throw new Error(body.fields?.name ?? body.message ?? 'Your name could not be saved. Try again.');
  }
}

function ProfileSettings() {
  const {me} = useMe();
  const [name, setName] = useState(me.name);
  const [color, setColor] = useState(me.color);
  // The name is the site account's (PATCH /site-api/auth/me); Kinroot keeps its copy and the colour.
  const save = useApiMutation(
    async (body: {name: string; color: string}) => {
      if (body.name !== me.name) await saveAccountName(body.name);
      return api.patch('/auth/me', body);
    },
    {invalidate: [keys.auth, keys.team], success: 'Saved'},
  );
  const picker = useRef<HTMLInputElement>(null);
  const upload = useApiMutation(
    (file: File) => {
      return uploadFile('/auth/me/avatar', file);
    },
    {invalidate: [keys.auth, keys.team], success: 'Profile picture updated'},
  );
  const removePhoto = useApiMutation(() => api.del('/auth/me/avatar'), {invalidate: [keys.auth, keys.team], success: 'Profile picture removed'});
  const pick = (file?: File) => {
    if (picker.current) picker.current.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return toast.error('Pictures can be up to 2 MB');
    upload.mutate(file);
  };

  return (
    <div>
      <SettingsSection title="Your profile" description={me.email}>
        <form onSubmit={(e) => (e.preventDefault(), save.mutate({name, color}))} className="grid gap-4">
          <div className="flex flex-wrap items-center gap-4">
            <Avatar name={name || me.name} color={color} src={me.avatarUrl} size="lg" className="size-16" />
            <div className="grid gap-2">
              <div className="flex flex-wrap gap-2">
                <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
                <Button type="button" variant="secondary" size="sm" onClick={() => picker.current?.click()} disabled={upload.isPending}>
                  {upload.isPending ? <Loader2 className="animate-spin" /> : <Camera />} {me.avatarUrl ? 'Change picture' : 'Upload picture'}
                </Button>
                {me.avatarUrl && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => removePhoto.mutate(undefined)} disabled={removePhoto.isPending}>
                    <Trash2 /> Remove
                  </Button>
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
          <Field label="Name" htmlFor="p-name"><Input id="p-name" required value={name} onChange={(e) => setName(e.target.value)} className="max-w-sm" /></Field>
          <div><Button type="submit" disabled={save.isPending}>Save profile</Button></div>
        </form>
      </SettingsSection>
      <SettingsSection title="Password and sign-in" description="Your password, two-step sign-in and signed-in devices belong to your account on this site.">
        <div>
          <Button asChild variant="secondary">
            <a href="/dashboard/account">
              <KeyRound /> Manage password and security
            </a>
          </Button>
        </div>
      </SettingsSection>
    </div>
  );
}
