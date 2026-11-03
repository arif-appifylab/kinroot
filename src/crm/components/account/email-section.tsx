import {useMutation, useQuery} from '@tanstack/react-query';
import {CheckCircle2, Mail} from 'lucide-react';
import {useState} from 'react';

import {SettingsSection} from '@/components/settings-section';
import {Badge} from '@/components/ui/badge';
import {Input} from '@/components/ui/form';
import {Skeleton} from '@/components/ui/misc';
import {accountApi, AccountError, twoFactorQuery, viewerQuery} from '@/lib/account-api';
import {AUTH_RULES, rules} from '../../../lib/rules';
import {FormError, FormField, FormNotice, PasswordInput, PendingButton, useForm} from './form';

/** The current password, when the account has one (an account made by "Open admin" may not). */
export function usePasswordNeeded() {
  return useQuery(twoFactorQuery).data?.hasPassword ?? true;
}

/**
 * Settings → Profile › Email address: the address you sign in with, whether it is confirmed,
 * and a change that only happens once the link sent to the NEW address is opened
 * (`POST /site-api/auth/email`; the link lands on `/account/confirm-email/`).
 */
export function EmailSection() {
  const viewer = useQuery(viewerQuery);
  const needsPassword = usePasswordNeeded();
  const form = useForm('email', {email: '', password: ''}, {email: AUTH_RULES.email, password: needsPassword ? [rules.required('Enter your current password.')] : []});
  const [sent, setSent] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: (values: {email: string; password: string}) => accountApi.requestEmailChange(values),
    onSuccess: (data) => {
      form.reset();
      setSent(data.message);
    },
    onError: (err) => err instanceof AccountError && form.setServerErrors(err.fields),
  });
  const resend = useMutation({mutationFn: (email: string) => accountApi.resendVerification(email)});
  const email = viewer.data?.email;

  return (
    <SettingsSection title="Email address" description="We send a link to the new address; nothing changes until you open it.">
      <div className="grid gap-5">
        <div className="grid gap-2">
          <p className="text-sm font-semibold text-slate-700">You sign in with</p>
          {viewer.data ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-900">
              <Mail className="size-4 text-slate-400" aria-hidden />
              <span className="font-medium break-all">{email}</span>
              {viewer.data.emailVerified ? (
                <Badge tone="green">
                  <CheckCircle2 aria-hidden /> Confirmed
                </Badge>
              ) : (
                <Badge tone="amber">Not confirmed yet</Badge>
              )}
            </div>
          ) : viewer.error ? (
            <FormError error={viewer.error} />
          ) : (
            <Skeleton className="h-5 w-64" />
          )}
          {viewer.data && !viewer.data.emailVerified && email && (
            <div className="grid justify-items-start gap-2">
              <PendingButton type="button" variant="secondary" size="sm" pending={resend.isPending} pendingLabel="Sending…" onClick={() => resend.mutate(email)}>
                <Mail /> Send the confirmation link again
              </PendingButton>
              {resend.data && <FormNotice tone="success">{resend.data.message}</FormNotice>}
              <FormError error={resend.error} />
            </div>
          )}
        </div>

        <form
          noValidate
          className="grid max-w-md gap-4"
          onSubmit={form.submit((values) => {
            setSent(null);
            change.mutate({email: values.email, password: values.password});
          })}
        >
          <FormField id={form.id('email')} label="New email address" error={form.error('email')}>
            <Input {...form.field('email')} type="email" autoComplete="email" inputMode="email" placeholder="name@example.com" />
          </FormField>
          {needsPassword && (
            <FormField id={form.id('password')} label="Current password" error={form.error('password')}>
              <PasswordInput {...form.field('password')} autoComplete="current-password" />
            </FormField>
          )}
          <FormError error={change.error} />
          {sent && <FormNotice tone="success">{sent}</FormNotice>}
          <div>
            <PendingButton type="submit" variant="secondary" pending={change.isPending} pendingLabel="Sending…">
              <Mail /> Send the link
            </PendingButton>
          </div>
        </form>
      </div>
    </SettingsSection>
  );
}
