import {useMutation} from '@tanstack/react-query';
import {Trash2} from 'lucide-react';
import {useState} from 'react';

import {Card} from '@/components/ui/card';
import {confirm} from '@/components/ui/confirm';
import {Input} from '@/components/ui/form';
import {accountApi, AccountError} from '@/lib/account-api';
import {rules} from '../../../lib/rules';
import {usePasswordNeeded} from './email-section';
import {FormError, FormField, PasswordInput, PendingButton, useForm} from './form';

/**
 * Settings → Security › Danger zone: deletes the account (`POST /site-api/auth/delete-account`),
 * signs out everywhere and leaves for the website. Typed DELETE, then one more confirmation.
 */
export function DeleteSection() {
  const needsPassword = usePasswordNeeded();
  const form = useForm(
    'delete',
    {password: '', confirm: ''},
    {
      password: needsPassword ? [rules.required('Enter your current password.')] : [],
      confirm: [rules.required('Type DELETE to confirm.'), rules.pattern(/^DELETE$/, 'Type DELETE, in capital letters, to confirm.')],
    },
  );
  // Leaves the page when done, so pending never needs resetting.
  const [gone, setGone] = useState(false);
  const remove = useMutation({
    mutationFn: (values: {password: string; confirm: string}) => accountApi.deleteAccount(values),
    onSuccess: () => {
      setGone(true);
      window.location.assign('/');
    },
    onError: (err) => err instanceof AccountError && form.setServerErrors(err.fields),
  });

  return (
    <Card className="mb-6 overflow-hidden border-rose-200">
      <div className="border-b border-rose-100 bg-rose-50/60 px-5 py-4">
        <h2 className="text-base font-bold text-rose-800">Delete your account</h2>
        <p className="mt-0.5 text-sm text-rose-700">This removes your account, takes you off this team and signs you out everywhere. It can't be undone.</p>
      </div>
      <form
        noValidate
        className="grid max-w-md gap-4 p-5"
        onSubmit={form.submit(async (values) => {
          const ok = await confirm({
            title: 'Delete your account for good?',
            description: 'Your sign-in, your place on this team and what is only yours (saved views, goals, connected calendars and inboxes) go now. Contacts, deals and other shared records stay with the team.',
            confirmLabel: 'Delete my account',
            destructive: true,
          });
          if (ok) remove.mutate({password: values.password, confirm: values.confirm.trim()});
        })}
      >
        {needsPassword && (
          <FormField id={form.id('password')} label="Current password" error={form.error('password')}>
            <PasswordInput {...form.field('password')} autoComplete="current-password" />
          </FormField>
        )}
        <FormField id={form.id('confirm')} label="Type DELETE to confirm" error={form.error('confirm')}>
          <Input {...form.field('confirm')} autoComplete="off" spellCheck={false} />
        </FormField>
        <FormError error={remove.error} />
        <div>
          <PendingButton type="submit" variant="destructive" pending={remove.isPending || gone} pendingLabel="Deleting…">
            <Trash2 /> Delete my account
          </PendingButton>
        </div>
      </form>
    </Card>
  );
}
