import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {useState} from 'react';
import {Toaster} from 'sonner';

import {SiteHome} from '@/components/site/site-home';
import {SiteLayout, type SitePage as Page} from '@/components/site/site-layout';
import {SiteContact, SiteDemo} from '@/components/site/site-pages';
import type {Brand} from '@/lib/brand';
import type {PublicWebsite} from '@/lib/website';
import {BrandProvider} from '@/lib/use-brand';

/**
 * The company's website (src/pages/index.astro, contact.astro, demo.astro): rendered on the server
 * (real HTML for search engines), then hydrated for the menu, the chat bubble, the form and the
 * booking widget. Content from Settings → Website, read by the page.
 */
export default function SitePage({site, brand, page}: {site: PublicWebsite; brand: Brand; page: Page}) {
  const [client] = useState(() => new QueryClient({defaultOptions: {queries: {staleTime: 15_000, retry: 1, refetchOnWindowFocus: false}}}));
  return (
    <QueryClientProvider client={client}>
      <BrandProvider brand={brand}>
        <SiteLayout site={site} page={page}>
          {page === 'home' ? <SiteHome site={site} /> : page === 'contact' ? <SiteContact site={site} /> : <SiteDemo site={site} />}
        </SiteLayout>
        <Toaster position="bottom-center" richColors />
      </BrandProvider>
    </QueryClientProvider>
  );
}
