import {SettingsSection} from '@/components/settings-section';
import {useBrand} from '@/lib/use-brand';

/**
 * The site owner's account has no email, password or two-step sign-in on the site: it comes from
 * the dashboard ("View as admin"), and the site's auth refuses those changes (403 `owner_account`).
 */
export function OwnerAccessNote() {
  const brand = useBrand();
  return (
    <SettingsSection
      title="You're the site owner"
      description={`Your access comes from the dashboard: open ${brand.name || 'the CRM'} from there with View as admin. There's no separate email, password or two-step sign-in here.`}
    >
      <p className="text-sm text-muted-foreground">To change how you sign in, change it in your dashboard account.</p>
    </SettingsSection>
  );
}
