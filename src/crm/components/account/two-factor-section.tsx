import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Copy, RefreshCw, ShieldCheck, ShieldOff} from 'lucide-react';
import {useState} from 'react';
import {toast} from 'sonner';

import {SettingsSection} from '@/components/settings-section';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {confirm} from '@/components/ui/confirm';
import {Input} from '@/components/ui/form';
import {Skeleton} from '@/components/ui/misc';
import {accountApi, AccountError, accountKeys, twoFactorQuery, type TwoFactorSetup} from '@/lib/account-api';
import {rules} from '../../../lib/rules';
import {FormError, FormField, FormNotice, PasswordInput, PendingButton, useForm} from './form';

const TITLE = 'Two-step sign-in';
const DESCRIPTION = 'A code from your phone as well as your password, so a stolen password is not enough.';

/**
 * Settings → Your account › Two-step sign-in (`/site-api/auth/two-factor/*`): set it up with a QR
 * code or the key, confirm with a code, see the recovery codes ONCE, make new ones, turn it off.
 * `codes` lives in the screen, so nothing on the page can drop codes not saved yet.
 */
export function TwoFactorSection({codes, setCodes}: {codes: string[] | null; setCodes: (codes: string[] | null) => void}) {
  const queryClient = useQueryClient();
  const status = useQuery(twoFactorQuery);
  const needsPassword = status.data?.hasPassword ?? true;
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const passwordForm = useForm('tfa', {password: ''}, {password: needsPassword ? [rules.required('Enter your current password.')] : []});
  const codeForm = useForm('tfa', {code: ''}, {code: [rules.required('Enter the 6-digit code from your app.')]});
  const refresh = () => queryClient.invalidateQueries({queryKey: accountKeys.twoFactor});
  const onPasswordError = (err: Error) => err instanceof AccountError && passwordForm.setServerErrors(err.fields);

  const start = useMutation({
    mutationFn: (password: string) => accountApi.startTwoFactor(password),
    onSuccess: (data) => {
      passwordForm.reset();
      setSetup(data);
    },
    onError: onPasswordError,
  });
  const enable = useMutation({
    mutationFn: (code: string) => accountApi.enableTwoFactor(code),
    onSuccess: (data) => {
      codeForm.reset();
      setSetup(null);
      setCodes(data.recoveryCodes);
      toast.success('Two-step sign-in is on.');
      return refresh();
    },
    onError: (err) => err instanceof AccountError && codeForm.setServerErrors(err.fields),
  });
  const disable = useMutation({
    mutationFn: (password: string) => accountApi.disableTwoFactor(password),
    onSuccess: () => {
      passwordForm.reset();
      setCodes(null);
      toast.success('Two-step sign-in is off.');
      return refresh();
    },
    onError: onPasswordError,
  });
  const renew = useMutation({
    mutationFn: (password: string) => accountApi.renewRecoveryCodes(password),
    onSuccess: (data) => {
      passwordForm.reset();
      setCodes(data.recoveryCodes);
      return refresh();
    },
    onError: onPasswordError,
  });
  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText((codes ?? []).join('\n'));
      toast.success('Copied the codes.');
    } catch {
      toast.error('Could not copy. Select the codes and copy them by hand.');
    }
  };

  if (!status.data) {
    return (
      <SettingsSection title={TITLE} description={DESCRIPTION}>
        {status.error ? <FormError error={status.error} /> : <Skeleton className="h-10 w-full max-w-md" />}
      </SettingsSection>
    );
  }

  const on = status.data.enabled;
  const passwordField = needsPassword && (
    <FormField id={passwordForm.id('password')} label="Current password" error={passwordForm.error('password')} className="max-w-sm">
      <PasswordInput {...passwordForm.field('password')} autoComplete="current-password" />
    </FormField>
  );

  return (
    <SettingsSection title={TITLE} description={DESCRIPTION} actions={<Badge tone={on ? 'green' : 'neutral'}>{on ? 'On' : 'Off'}</Badge>}>
      <div className="grid gap-4">
        {codes && (
          <FormNotice tone="success" title="Save your recovery codes now">
            <p>Each one signs you in once if you lose your phone. You won't see them again.</p>
            <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-5" aria-label="Recovery codes">
              {codes.map((code) => (
                <li key={code}>
                  <code className="block rounded-lg bg-card px-2 py-1 text-center font-mono text-[13px] tracking-wide text-slate-900 ring-1 ring-green-200 select-all">{code}</code>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => void copyCodes()}>
                <Copy /> Copy codes
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setCodes(null)}>
                I saved them
              </Button>
            </div>
          </FormNotice>
        )}

        {on ? (
          <form
            noValidate
            className="grid gap-4"
            onSubmit={(event) => {
              // Enter in the password field means the first button: new recovery codes.
              const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'disable' ? 'disable' : 'renew';
              passwordForm.submit(async (values) => {
                const ok = await confirm(
                  action === 'disable'
                    ? {title: 'Turn off two-step sign-in?', description: 'Signing in then asks only for your password, and your recovery codes stop working.', confirmLabel: 'Turn off', destructive: true}
                    : {title: 'Make new recovery codes?', description: 'Your current recovery codes stop working. Save the new ones somewhere safe.', confirmLabel: 'Make new codes'},
                );
                if (ok) (action === 'disable' ? disable : renew).mutate(values.password);
              })(event);
            }}
          >
            <p className="text-sm text-slate-600">Signing in asks for a code from your authenticator app. Recovery codes left: {status.data.recoveryCodesLeft}.</p>
            {passwordField}
            <FormError error={renew.error ?? disable.error} />
            <div className="flex flex-wrap gap-2">
              <PendingButton type="submit" value="renew" variant="secondary" pending={renew.isPending} disabled={disable.isPending} pendingLabel="Making codes…">
                <RefreshCw /> New recovery codes
              </PendingButton>
              <PendingButton type="submit" value="disable" variant="destructive" pending={disable.isPending} disabled={renew.isPending} pendingLabel="Turning off…">
                <ShieldOff /> Turn off
              </PendingButton>
            </div>
          </form>
        ) : setup ? (
          <form noValidate className="grid gap-4" onSubmit={codeForm.submit((values) => enable.mutate(values.code))}>
            <p className="text-sm text-slate-600">Scan this with an authenticator app (Google Authenticator, 1Password, Authy…), then enter the code it shows.</p>
            <img src={setup.qr} alt="QR code for your authenticator app" width={180} height={180} className="size-[180px] rounded-xl bg-white p-1 ring-1 ring-slate-200" />
            <p className="text-sm text-slate-600">
              Can't scan? Enter this key in the app: <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[13px] break-all text-slate-900 select-all">{setup.secret}</code>
            </p>
            <FormField id={codeForm.id('code')} label="6-digit code" error={codeForm.error('code')} className="max-w-[12rem]">
              <Input {...codeForm.field('code')} autoComplete="one-time-code" inputMode="numeric" maxLength={8} placeholder="123456" />
            </FormField>
            <FormError error={enable.error} />
            <div className="flex flex-wrap gap-2">
              <PendingButton type="submit" pending={enable.isPending} pendingLabel="Checking…">
                <ShieldCheck /> Turn on
              </PendingButton>
              <Button
                type="button"
                variant="secondary"
                disabled={enable.isPending}
                onClick={() => {
                  setSetup(null);
                  codeForm.reset();
                  enable.reset();
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <form noValidate className="grid gap-4" onSubmit={passwordForm.submit((values) => start.mutate(values.password))}>
            <p className="text-sm text-slate-600">Turn it on and signing in also asks for a code from your phone.</p>
            {passwordField}
            <FormError error={start.error} />
            <div>
              <PendingButton type="submit" variant="secondary" pending={start.isPending} pendingLabel="Starting…">
                <ShieldCheck /> Set up two-step sign-in
              </PendingButton>
            </div>
          </form>
        )}
      </div>
    </SettingsSection>
  );
}
