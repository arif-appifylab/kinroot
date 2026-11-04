import {useEffect} from 'react';

import {Input} from '@/components/ui/form';
import {PasswordInput} from '@/components/ui/password-input';
import {BRAND, type Brand} from '@/lib/brand';

import {rememberSignUpEmail, signedIn} from '../../../lib/account';
import {postJson} from '../../../lib/form';
import {AUTH_RULES, passwordMeetsRules} from '../../../lib/rules';
import {siteFetch} from '../../../platform/browser';
import {AuthField, LinksRow, PasswordChecklist, PendingButton, StatusLine, TextLink} from './parts';
import {AuthShell, useNext, withNext} from './shell';
import {useAuthForm} from './use-auth-form';

/**
 * /account/register/ (src/pages/account/register.astro): posts to `/site-api/auth/register`. The
 * answer is the same whether or not the email already has an account, and no account exists until
 * the emailed 6-digit code (or link) comes back in THIS browser: so it goes straight on to the code
 * page, `/account/verify/`, carrying the address for this tab (never in the URL).
 */
export default function RegisterPage({brand}: {brand: Brand}) {
  const next = useNext();

  useEffect(() => {
    void signedIn().then((yes) => yes && window.location.replace(next));
  }, [next]);

  const form = useAuthForm({
    idPrefix: 'register',
    initial: {name: '', email: '', password: ''},
    rules: (values) => ({name: AUTH_RULES.name, email: AUTH_RULES.email, password: [passwordMeetsRules(() => values.email)]}),
    async submit(values) {
      const {result} = await postJson(siteFetch, '/site-api/auth/register', values);
      if (!result.ok) return result;
      rememberSignUpEmail(values.email.trim());
      return {ok: true, redirect: withNext('/account/verify/', next)};
    },
  });

  const name = brand.name.trim() || BRAND.name;
  return (
    <AuthShell
      brand={brand}
      title="Create your"
      highlight={`${name} account`}
      subtitle="Your name, your email and a password. That is all."
      footer={
        <LinksRow>
          Already have an account? <TextLink href={withNext('/account/login/', next)}>Sign in</TextLink>
        </LinksRow>
      }
    >
      <form noValidate onSubmit={form.onSubmit} className="grid gap-4">
        <AuthField id="register-name" label="Your name" error={form.error('name')}>
          <Input {...form.input('name')} type="text" autoComplete="name" maxLength={80} />
        </AuthField>
        <AuthField id="register-email" label="Email" error={form.error('email')}>
          <Input {...form.input('email')} type="email" autoComplete="email" inputMode="email" placeholder="name@example.com" />
        </AuthField>
        <AuthField id="register-password" label="Password" error={form.error('password')} hint="A short sentence works well.">
          <PasswordInput {...form.input('password')} autoComplete="new-password" aria-describedby={described(form.error('password'), 'register-password')} />
          <PasswordChecklist id="register-password-checks" password={form.values.password} email={form.values.email} tried={form.submitted} />
        </AuthField>
        <StatusLine status={form.status} />
        <PendingButton type="submit" size="lg" className="w-full" pending={form.pending} pendingLabel="Creating account…">
          Create account
        </PendingButton>
      </form>
    </AuthShell>
  );
}

/** The password field is described by its error (or hint) and, always, its live checklist. */
const described = (error: string | null, id: string) => [error ? `${id}-error` : `${id}-hint`, `${id}-checks`].join(' ');
