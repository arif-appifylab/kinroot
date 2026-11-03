import {ArrowLeft} from 'lucide-react';
import {useState, type ReactNode} from 'react';

import {AuthLayout} from '@/components/auth-layout';
import type {Brand} from '@/lib/brand';
import {BrandProvider} from '@/lib/use-brand';

import {nextPath, takeToken} from '../../../lib/account';

/**
 * The frame of every sign-in page (src/pages/account/*): Kinroot's split auth screen, branded from
 * Settings → Branding (the brand the Astro page read on the server), with a way back to the website
 * under the card. These islands are `client:only`: no form exists before its code runs, so a press
 * of Enter can never send a password as a plain GET form.
 */
export function AuthShell({brand, title, highlight, subtitle, footer, children}: {brand: Brand; title: string; highlight: string; subtitle?: ReactNode; footer?: ReactNode; children: ReactNode}) {
  return (
    <BrandProvider brand={brand}>
      <AuthLayout
        title={title}
        highlight={highlight}
        subtitle={subtitle}
        footer={
          <div className="grid gap-4">
            {footer}
            <p className="text-center">
              <a href="/" className="inline-flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                <ArrowLeft className="size-3.5" aria-hidden /> Back to the website
              </a>
            </p>
          </div>
        }
      >
        {children}
      </AuthLayout>
    </BrandProvider>
  );
}

/** `?next=` (same-site paths only, else Kinroot), read once when the page opens. */
export function useNext(): string {
  const [next] = useState(() => nextPath());
  return next;
}

/** A link to another sign-in page that keeps where to go afterwards. */
export const withNext = (path: string, next: string) => `${path}?next=${encodeURIComponent(next)}`;

let token: string | null | undefined;

/**
 * The emailed link's `?token=`, taken out of the address bar the moment the page opens
 * (`takeToken`), and kept here: a second render must not read the now-clean address as "no token".
 */
export function pageToken(): string | null {
  if (token === undefined) token = takeToken();
  return token;
}
