import {useQuery} from '@tanstack/react-query';
import {createFileRoute} from '@tanstack/react-router';
import {useState} from 'react';

import {DeleteSection} from '@/components/account/delete-section';
import {DevicesSection} from '@/components/account/devices-section';
import {OwnerAccessNote} from '@/components/account/owner-note';
import {PasswordSection} from '@/components/account/password-section';
import {TwoFactorSection} from '@/components/account/two-factor-section';
import {viewerQuery} from '@/lib/account-api';
import {pageTitle} from '@/lib/brand';
import {useMe} from '@/lib/queries';

export const Route = createFileRoute('/_app/settings/security')({
  head: () => ({meta: [{title: pageTitle('Security')}]}),
  component: SecuritySettings,
});

/**
 * Settings → Security: your password, two-step sign-in, signed-in devices and deleting the
 * account. Every action is the site's auth core (`/site-api/auth/*`, src/lib/account-api.ts). The site
 * owner only sees their devices: the rest comes from the dashboard.
 */
function SecuritySettings() {
  const {me} = useMe();
  const viewer = useQuery(viewerQuery);
  // Held here: nothing else on the page can drop recovery codes not saved yet.
  const [codes, setCodes] = useState<string[] | null>(null);
  // The account's own email, for the "not your email address" password rule.
  const email = viewer.data?.email ?? me.email ?? '';

  if (viewer.data?.platformOwner || me.accountOwner) {
    return (
      <div>
        <OwnerAccessNote />
        <DevicesSection />
      </div>
    );
  }

  return (
    <div>
      <PasswordSection email={email} />
      <TwoFactorSection codes={codes} setCodes={setCodes} />
      <DevicesSection />
      <DeleteSection />
    </div>
  );
}
