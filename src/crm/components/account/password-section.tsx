import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {KeyRound, Mail} from 'lucide-react';
import {useState} from 'react';

import {SettingsSection} from '@/components/settings-section';
import {Skeleton} from '@/components/ui/misc';
import {accountApi, AccountError, accountKeys, twoFactorQuery} from '@/lib/account-api';
import {matchCheck, passwordChecks} from '../../../lib/password-checks';
import {rules} from '../../../lib/rules';
import {FormError, FormField, FormNotice, PasswordChecks, PasswordInput, PendingButton, useForm} from './form';

const describedBy = (...ids: (string | undefined)[]) => ids.filter(Boolean).join(' ') || undefined;

/**
 * Settings → Security › Password. With a password: change it (`POST /site-api/auth/change-password`,
 * other devices are signed out). Without one (an account that signs in with emailed codes):
 * a link to choose one (`POST /site-api/auth/forgot-password`, the reset page sets it).
 */
export function PasswordSection({email}: {email: string}) {
  const status = useQuery(twoFactorQuery);
  if (!status.data) {
    return (
      <SettingsSection title="Password" description="Use one you don't use anywhere else.">
        {status.error ? <FormError error={status.error} /> : <Skeleton className="h-10 w-full max-w-md" />}
      </SettingsSection>
    );
  }
  return status.data.hasPassword ? <ChangePassword email={email} /> : <SetPassword email={email} />;
}

function ChangePassword({email}: {email: string}) {
  const queryClient = useQueryClient();
  const form = useForm(
    'pw',
    {currentPassword: '', newPassword: '', confirm: ''},
    {
      currentPassword: [rules.required('Enter your current password.')],
      newPassword: [rules.passwordMeetsRules(() => email)],
      confirm: [rules.required('Type the new password again.')],
    },
  );
  const [done, setDone] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const change = useMutation({
    mutationFn: (values: {currentPassword: string; newPassword: string}) => accountApi.changePassword(values),
    onSuccess: (data) => {
      form.reset();
      setTried(false);
      setDone(data.message);
      // Every other device was signed out.
      return queryClient.invalidateQueries({queryKey: accountKeys.sessions});
    },
    onError: (err) => err instanceof AccountError && form.setServerErrors(err.fields),
  });
  const newField = form.field('newPassword');
  const confirmField = form.field('confirm');

  return (
    <SettingsSection title="Password" description="Use one you don't use anywhere else. Changing it signs out your other devices.">
      <form
        noValidate
        className="grid max-w-2xl gap-4"
        onSubmit={(event) => {
          setTried(true);
          form.submit((values) => {
            setDone(null);
            if (values.confirm !== values.newPassword) {
              form.setServerErrors({confirm: 'The two passwords are not the same.'});
              return;
            }
            change.mutate({currentPassword: values.currentPassword, newPassword: values.newPassword});
          })(event);
        }}
      >
        <FormField id={form.id('currentPassword')} label="Current password" error={form.error('currentPassword')} className="max-w-sm">
          <PasswordInput {...form.field('currentPassword')} autoComplete="current-password" />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid content-start gap-2">
            <FormField id={newField.id} label="New password" error={form.error('newPassword')}>
              <PasswordInput {...newField} aria-describedby={describedBy(newField['aria-describedby'], `${newField.id}-checks`)} autoComplete="new-password" />
            </FormField>
            <PasswordChecks id={`${newField.id}-checks`} tried={tried} checks={passwordChecks(form.values.newPassword, email)} />
          </div>
          <div className="grid content-start gap-2">
            <FormField id={confirmField.id} label="Type it again" error={form.error('confirm')}>
              <PasswordInput {...confirmField} aria-describedby={describedBy(confirmField['aria-describedby'], `${confirmField.id}-checks`)} autoComplete="new-password" />
            </FormField>
            {(form.values.confirm || tried) && <PasswordChecks id={`${confirmField.id}-checks`} tried={tried} checks={[matchCheck(form.values.newPassword, form.values.confirm)]} />}
          </div>
        </div>
        <FormError error={change.error} />
        {done && <FormNotice tone="success">{done}</FormNotice>}
        <div>
          <PendingButton type="submit" pending={change.isPending} pendingLabel="Changing…">
            <KeyRound /> Change password
          </PendingButton>
        </div>
      </form>
    </SettingsSection>
  );
}

function SetPassword({email}: {email: string}) {
  const send = useMutation({mutationFn: () => accountApi.sendPasswordLink(email)});
  return (
    <SettingsSection title="Password" description="You sign in with a code we email you. Add a password to sign in with it too.">
      <div className="grid max-w-xl gap-4">
        <p className="text-sm text-slate-600">
          We email <span className="font-medium text-slate-900 break-all">{email}</span> a link to choose your password. It works for 30 minutes.
        </p>
        <FormError error={send.error} />
        {send.data && <FormNotice tone="success">{send.data.message}</FormNotice>}
        <div>
          <PendingButton type="button" variant="secondary" pending={send.isPending} pendingLabel="Sending…" onClick={() => send.mutate()}>
            <Mail /> Email me a link to set a password
          </PendingButton>
        </div>
      </div>
    </SettingsSection>
  );
}
