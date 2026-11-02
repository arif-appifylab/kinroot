import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useNavigate, useSearch} from '@tanstack/react-router';
import {useState} from 'react';

import {matchCheck, passwordChecks} from '../../lib/password-checks';
import {AUTH_RULES, rules} from '../../lib/rules';
import type {Viewer} from '../../lib/types';
import {api, ApiError, read} from '../api';
import {type DeviceSession, sessionsQuery, twoFactorQuery} from '../queries';
import {ago, useMe} from '../shared';
import {
  Avatar,
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  Icon,
  LoadingBlock,
  Notice,
  PageHeader,
  PasswordChecks,
  PasswordInput,
  StatusBadge,
  Tabs,
  useConfirm,
  useForm,
  useToast,
} from '../ui';

const TABS = [
  {value: 'profile', label: 'Profile'},
  {value: 'security', label: 'Security'},
  {value: 'devices', label: 'Devices'},
  {value: 'danger', label: 'Danger zone'},
] as const;
type TabKey = (typeof TABS)[number]['value'];

/** A form's error that belongs to no field: shown in its status line, not on a field. */
const formError = (error: Error | null) =>
  error && !(error instanceof ApiError && Object.keys(error.fields).length) ? <ErrorNote error={error} /> : null;

/**
 * `/dashboard/account`: your name, email, password, two-step sign-in, signed-in devices, and
 * deleting the account. Every action is the auth core's (`/site-api/auth/*`, docs/agent/auth.md).
 * The open tab is the `?tab=` search param, so a link can open "Security" directly.
 */
export function Account() {
  const me = useMe();
  const viewer = me.data?.viewer;
  const search = useSearch({from: '/account'});
  const navigate = useNavigate();
  const tab: TabKey = TABS.find(item => item.value === search.tab)?.value ?? 'profile';
  const pick = (next: TabKey) =>
    void navigate({to: '/account', search: next === 'profile' ? {} : {tab: next}, replace: true});
  // Held here, not in the tab: switching tabs never loses codes the visitor has not saved yet.
  const [codes, setCodes] = useState<string[] | null>(null);

  return (
    <div className="app-page account-screen">
      <PageHeader title="Your account" description="Your profile, how you sign in, and the devices signed in to this account." />
      {!viewer ? (
        me.error ? (
          <ErrorNote error={me.error} />
        ) : (
          <Card>
            <LoadingBlock rows={2} />
          </Card>
        )
      ) : (
        <Tabs label="Account sections" items={[...TABS]} value={tab} onChange={pick}>
          <div className="account-panel">
            {tab === 'profile' && (
              <>
                <ProfileSection viewer={viewer} />
                <EmailSection viewer={viewer} />
              </>
            )}
            {tab === 'security' && (
              <>
                <PasswordSection viewer={viewer} />
                <TwoFactorSection codes={codes} setCodes={setCodes} />
              </>
            )}
            {tab === 'devices' && <DevicesSection />}
            {tab === 'danger' && <DeleteSection />}
          </div>
        </Tabs>
      )}
    </div>
  );
}

function ProfileSection({viewer}: {viewer: Viewer}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const profile = useForm({name: viewer.name ?? ''}, {name: AUTH_RULES.name});
  const saveProfile = useMutation({
    mutationFn: (values: {name: string}) => read(api.auth.me.$patch({json: values})),
    onSuccess: () => {
      toast.success('Saved your name.');
      return queryClient.invalidateQueries({queryKey: ['me']});
    },
    onError: err => err instanceof ApiError && profile.setServerErrors(err.fields),
  });
  const shownName = viewer.name || viewer.email || 'You';
  return (
    <Card title="Profile" description="How your name shows to the people who run this site.">
      <div className="account-who">
        <Avatar name={shownName} size="lg" />
        <div className="account-who-text">
          <p className="account-who-name">{viewer.name || 'No name yet'}</p>
          <p className="account-who-email">
            {viewer.email}
            {viewer.emailVerified ? (
              <Badge tone="success" icon="check">
                Confirmed
              </Badge>
            ) : (
              <Badge tone="warning">Not confirmed yet</Badge>
            )}
          </p>
        </div>
      </div>
      <form className="form-stack" noValidate onSubmit={profile.submit(values => saveProfile.mutate({name: values.name}))}>
        <Field id="f-name" label="Your name" error={profile.error('name')}>
          <input {...profile.field('name')} autoComplete="name" />
        </Field>
        {saveProfile.error && !(saveProfile.error instanceof ApiError && saveProfile.error.fields.name) && (
          <ErrorNote error={saveProfile.error} />
        )}
        <div className="form-actions">
          <Button type="submit" pending={saveProfile.isPending} pendingLabel="Saving…">
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** The current password, when the account has one (an account made by the dashboard's "Open admin" may not). */
function usePasswordNeeded() {
  const status = useQuery(twoFactorQuery);
  return status.data?.hasPassword ?? true;
}

function EmailSection({viewer}: {viewer: Viewer}) {
  const needsPassword = usePasswordNeeded();
  const form = useForm(
    {email: '', password: ''},
    {email: AUTH_RULES.email, password: needsPassword ? [rules.required('Enter your current password.')] : []}
  );
  const [sent, setSent] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: (values: {email: string; password: string}) => read<{message: string}>(api.auth.email.$post({json: values})),
    onSuccess: data => {
      form.reset();
      setSent(data.message);
    },
    onError: err => err instanceof ApiError && form.setServerErrors(err.fields),
  });
  return (
    <Card
      title="Email address"
      description={`You sign in with ${viewer.email ?? 'your email'}. We send a link to the new address; nothing changes until you open it.`}>
      <form
        className="form-stack"
        noValidate
        onSubmit={form.submit(values => {
          setSent(null);
          change.mutate({email: values.email, password: values.password});
        })}>
        <Field id="f-newEmail" label="New email address" error={form.error('email')}>
          <input {...form.field('email')} type="email" autoComplete="email" inputMode="email" />
        </Field>
        {needsPassword && (
          <Field id="f-emailPassword" label="Current password" error={form.error('password')}>
            <PasswordInput {...form.field('password')} autoComplete="current-password" />
          </Field>
        )}
        {formError(change.error)}
        {sent && <Notice tone="success">{sent}</Notice>}
        <div className="form-actions">
          <Button type="submit" variant="secondary" icon="mail" pending={change.isPending} pendingLabel="Sending…">
            Send the link
          </Button>
        </div>
      </form>
    </Card>
  );
}

function PasswordSection({viewer}: {viewer: Viewer}) {
  const password = useForm(
    {currentPassword: '', newPassword: '', confirm: ''},
    {
      currentPassword: [rules.required('Enter your current password.')],
      newPassword: [rules.passwordMeetsRules(() => viewer.email ?? '')],
      confirm: [rules.required('Type the new password again.')],
    }
  );
  const [passwordDone, setPasswordDone] = useState<string | null>(null);
  const [passwordTried, setPasswordTried] = useState(false);
  const changePassword = useMutation({
    mutationFn: (values: {currentPassword: string; newPassword: string}) =>
      read<{message: string}>(api.auth['change-password'].$post({json: values})),
    onSuccess: data => {
      password.reset();
      setPasswordTried(false);
      setPasswordDone(data.message);
    },
    onError: err => err instanceof ApiError && password.setServerErrors(err.fields),
  });
  return (
    <Card title="Password" description="Use one you don't use anywhere else.">
      <form
        className="form-stack"
        noValidate
        onSubmit={event => {
          setPasswordTried(true);
          password.submit(values => {
            setPasswordDone(null);
            if (values.confirm !== values.newPassword) {
              password.setServerErrors({confirm: 'The two passwords are not the same.'});
              return;
            }
            changePassword.mutate({currentPassword: values.currentPassword, newPassword: values.newPassword});
          })(event);
        }}>
        <Field id="f-currentPassword" label="Current password" error={password.error('currentPassword')}>
          <PasswordInput {...password.field('currentPassword')} autoComplete="current-password" />
        </Field>
        <div className="form-grid">
          <div className="pw-field">
            <Field id="f-newPassword" label="New password" error={password.error('newPassword')}>
              <PasswordInput
                {...password.field('newPassword')}
                aria-describedby={`${password.field('newPassword')['aria-describedby']} f-newPassword-checks`}
                autoComplete="new-password"
              />
            </Field>
            <PasswordChecks
              id="f-newPassword-checks"
              tried={passwordTried}
              checks={passwordChecks(password.values.newPassword, viewer.email ?? '')}
            />
          </div>
          <div className="pw-field">
            <Field id="f-confirm" label="Type it again" error={password.error('confirm')}>
              <PasswordInput
                {...password.field('confirm')}
                aria-describedby={`${password.field('confirm')['aria-describedby']} f-confirm-checks`}
                autoComplete="new-password"
              />
            </Field>
            {(password.values.confirm || passwordTried) && (
              <PasswordChecks
                id="f-confirm-checks"
                tried={passwordTried}
                checks={[matchCheck(password.values.newPassword, password.values.confirm)]}
              />
            )}
          </div>
        </div>
        {formError(changePassword.error)}
        {passwordDone && <Notice tone="success">{passwordDone}</Notice>}
        <div className="form-actions">
          <Button type="submit" pending={changePassword.isPending} pendingLabel="Changing…">
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}

function TwoFactorSection({codes, setCodes}: {codes: string[] | null; setCodes: (codes: string[] | null) => void}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const status = useQuery(twoFactorQuery);
  const needsPassword = status.data?.hasPassword ?? true;
  const [setup, setSetup] = useState<{secret: string; uri: string; qr: string} | null>(null);
  const passwordForm = useForm({password: ''}, {password: needsPassword ? [rules.required('Enter your current password.')] : []});
  const codeForm = useForm({code: ''}, {code: [rules.required('Enter the 6-digit code from your app.')]});
  const refresh = () => queryClient.invalidateQueries({queryKey: ['account', 'two-factor']});

  const start = useMutation({
    mutationFn: (values: {password: string}) =>
      read<{secret: string; uri: string; qr: string}>(api.auth['two-factor'].setup.$post({json: values})),
    onSuccess: data => {
      passwordForm.reset();
      setSetup(data);
    },
    onError: err => err instanceof ApiError && passwordForm.setServerErrors(err.fields),
  });
  const enable = useMutation({
    mutationFn: (values: {code: string}) => read<{recoveryCodes: string[]}>(api.auth['two-factor'].enable.$post({json: values})),
    onSuccess: data => {
      codeForm.reset();
      setSetup(null);
      setCodes(data.recoveryCodes);
      toast.success('Two-step sign-in is on.');
      return refresh();
    },
    onError: err => err instanceof ApiError && codeForm.setServerErrors(err.fields),
  });
  const disable = useMutation({
    mutationFn: (values: {password: string}) => read(api.auth['two-factor'].disable.$post({json: values})),
    onSuccess: () => {
      passwordForm.reset();
      setCodes(null);
      toast.success('Two-step sign-in is off.');
      return refresh();
    },
    onError: err => err instanceof ApiError && passwordForm.setServerErrors(err.fields),
  });
  const renew = useMutation({
    mutationFn: (values: {password: string}) =>
      read<{recoveryCodes: string[]}>(api.auth['two-factor']['recovery-codes'].$post({json: values})),
    onSuccess: data => {
      passwordForm.reset();
      setCodes(data.recoveryCodes);
      return refresh();
    },
    onError: err => err instanceof ApiError && passwordForm.setServerErrors(err.fields),
  });
  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText((codes ?? []).join('\n'));
      toast.success('Copied the codes.');
    } catch {
      toast.danger('Could not copy. Select the codes and copy them by hand.');
    }
  };

  const title = 'Two-step sign-in';
  const description = 'A code from your phone as well as your password, so a stolen password is not enough.';
  if (!status.data) {
    return <Card title={title} description={description}>{status.error ? <ErrorNote error={status.error} /> : <LoadingBlock rows={1} />}</Card>;
  }

  const passwordField = needsPassword && (
    <Field id="f-2faPassword" label="Current password" error={passwordForm.error('password')}>
      <PasswordInput {...passwordForm.field('password')} autoComplete="current-password" />
    </Field>
  );
  const failed = start.error ?? enable.error ?? disable.error ?? renew.error;
  const on = status.data.enabled;

  return (
    <Card
      title={title}
      description={description}
      actions={<StatusBadge tone={on ? 'success' : 'neutral'}>{on ? 'On' : 'Off'}</StatusBadge>}>
      <div className="form-stack">
        {codes && (
          <Notice
            tone="success"
            title="Save your recovery codes now">
            <p>Each one signs you in once if you lose your phone. You won't see them again.</p>
            <ul className="recovery-codes">
              {codes.map(code => (
                <li key={code}>
                  <code>{code}</code>
                </li>
              ))}
            </ul>
            <div className="form-actions">
              <Button variant="secondary" size="sm" icon="copy" onClick={() => void copyCodes()}>
                Copy codes
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setCodes(null)}>
                I saved them
              </Button>
            </div>
          </Notice>
        )}

        {on ? (
          <form
            className="form-stack"
            noValidate
            onSubmit={event => {
              const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value');
              passwordForm.submit(values => (action === 'renew' ? renew : disable).mutate({password: values.password}))(event);
            }}>
            <p className="muted">
              Signing in asks for a code from your authenticator app. Recovery codes left: {status.data.recoveryCodesLeft}.
            </p>
            {passwordField}
            {formError(failed)}
            <div className="form-actions">
              <Button
                type="submit"
                value="renew"
                variant="secondary"
                icon="refresh"
                pending={renew.isPending}
                disabled={disable.isPending}
                pendingLabel="Making codes…">
                New recovery codes
              </Button>
              <Button
                type="submit"
                value="disable"
                variant="danger"
                pending={disable.isPending}
                disabled={renew.isPending}
                pendingLabel="Turning off…">
                Turn off
              </Button>
            </div>
          </form>
        ) : setup ? (
          <form className="form-stack" noValidate onSubmit={codeForm.submit(values => enable.mutate({code: values.code}))}>
            <p className="muted">Scan this with an authenticator app (Google Authenticator, 1Password, Authy…), then enter the code it shows.</p>
            <img className="qr" src={setup.qr} alt="QR code for your authenticator app" width={180} height={180} />
            <p className="muted account-secret">
              Can't scan? Enter this key in the app: <code>{setup.secret}</code>
            </p>
            <Field id="f-2faCode" label="6-digit code" error={codeForm.error('code')}>
              <input {...codeForm.field('code')} autoComplete="one-time-code" inputMode="numeric" maxLength={8} />
            </Field>
            {formError(enable.error)}
            <div className="form-actions">
              <Button type="submit" pending={enable.isPending} pendingLabel="Checking…">
                Turn on
              </Button>
              <Button variant="secondary" onClick={() => setSetup(null)} disabled={enable.isPending}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <form className="form-stack" noValidate onSubmit={passwordForm.submit(values => start.mutate({password: values.password}))}>
            <p className="muted">Turn it on and signing in also asks for a code from your phone.</p>
            {passwordField}
            {formError(start.error)}
            <div className="form-actions">
              <Button type="submit" variant="secondary" icon="shield" pending={start.isPending} pendingLabel="Starting…">
                Set up two-step sign-in
              </Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

/** A laptop or a phone, guessed from the device's label ("Safari on iPhone"). */
const deviceIcon = (device: string) => (/iphone|ipad|android|mobile|phone|tablet/i.test(device) ? 'phone' : 'laptop');

function DevicesSection() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const sessions = useQuery(sessionsQuery);
  // Reloads when done (every page then renders signed out), so pending never needs resetting.
  const [endingAll, setEndingAll] = useState(false);
  const logoutAll = useMutation({
    mutationFn: () => read(api.auth['logout-all'].$post()),
    onMutate: () => setEndingAll(true),
    onSuccess: () => window.location.assign('/account/login/'),
    onError: () => setEndingAll(false),
  });
  const signOut = useMutation({
    mutationFn: (session: DeviceSession) => read(api.auth.sessions[':id'].$delete({param: {id: session.id}})),
    onSuccess: (_data, session) => {
      if (session.current) {
        window.location.assign('/account/login/');
        return;
      }
      toast.success(`Signed out ${session.device}.`);
      return queryClient.invalidateQueries({queryKey: ['account', 'sessions']});
    },
  });
  const signingOut = signOut.isPending ? signOut.variables?.id : null;

  return (
    <Card
      flush
      title="Signed-in devices"
      description="Where your account is signed in now. Sign out any you don't know."
      actions={
        <Button
          variant="secondary"
          icon="log-out"
          pending={endingAll}
          pendingLabel="Signing out…"
          disabled={!sessions.data}
          onClick={() =>
            void confirm({
              title: 'Sign out everywhere?',
              body: 'Every device signs out, including this one. You sign in again with your password.',
              confirmLabel: 'Sign out everywhere',
              pendingLabel: 'Signing out…',
              action: () => logoutAll.mutateAsync(),
            })
          }>
          Sign out everywhere
        </Button>
      }>
      {sessions.error && (
        <div className="account-flush-note">
          <ErrorNote error={sessions.error} />
        </div>
      )}
      {!sessions.data && !sessions.error && <LoadingBlock rows={2} />}
      {sessions.data && (
        <ul className="list">
          {sessions.data.sessions.map(session => (
            <li key={session.id} className="list-row" aria-busy={signingOut === session.id || undefined}>
              <span className="list-row-icon" data-tone={session.current ? 'brand' : undefined}>
                <Icon name={deviceIcon(session.device)} size={18} />
              </span>
              <div className="list-row-text">
                <p className="list-row-title">
                  {session.device}
                  {session.current && <Badge tone="brand">This device</Badge>}
                </p>
                <p className="list-row-sub">Active {ago(session.lastActiveAt)}</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                pending={signingOut === session.id}
                disabled={(signingOut != null && signingOut !== session.id) || endingAll}
                pendingLabel="Signing out…"
                onClick={() => signOut.mutate(session)}>
                Sign out
              </Button>
            </li>
          ))}
        </ul>
      )}
      {(signOut.error || logoutAll.error) && (
        <div className="account-flush-note">
          <ErrorNote error={(signOut.error ?? logoutAll.error)!} />
        </div>
      )}
    </Card>
  );
}

function DeleteSection() {
  const needsPassword = usePasswordNeeded();
  const form = useForm(
    {password: '', confirm: ''},
    {
      password: needsPassword ? [rules.required('Enter your current password.')] : [],
      confirm: [rules.required('Type DELETE to confirm.')],
    }
  );
  const remove = useMutation({
    mutationFn: (values: {password: string; confirm: string}) => read(api.auth['delete-account'].$post({json: values})),
    onSuccess: () => window.location.assign('/'),
    onError: err => err instanceof ApiError && form.setServerErrors(err.fields),
  });
  return (
    <Card tone="danger" title="Delete your account" description="This removes your account and signs you out everywhere. It can't be undone.">
      <form
        className="form-stack"
        noValidate
        onSubmit={form.submit(values => remove.mutate({password: values.password, confirm: values.confirm.trim()}))}>
        {needsPassword && (
          <Field id="f-deletePassword" label="Current password" error={form.error('password')}>
            <PasswordInput {...form.field('password')} autoComplete="current-password" />
          </Field>
        )}
        <Field id="f-deleteConfirm" label="Type DELETE to confirm" error={form.error('confirm')}>
          <input {...form.field('confirm')} autoComplete="off" spellCheck={false} />
        </Field>
        {formError(remove.error)}
        <div className="form-actions">
          <Button type="submit" variant="danger" icon="trash" pending={remove.isPending} pendingLabel="Deleting…">
            Delete my account
          </Button>
        </div>
      </form>
    </Card>
  );
}
