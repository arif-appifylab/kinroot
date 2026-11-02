import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {useState, type ReactNode} from 'react';
import {Toaster} from 'sonner';

import {ConfirmHost} from '@/components/ui/confirm';
import {PublicLayout} from '@/components/public-layout';
import type {Brand} from '@/lib/brand';
import {BrandProvider} from '@/lib/use-brand';

/** Kinroot's public frame (header, footer, brand) for a page rendered by Astro (src/pages/support, /book, …). */
export function PublicPage({brand, children, bare = false}: {brand: Brand; children: ReactNode; bare?: boolean}) {
  // Some public components read through React Query (the booking widget's open times).
  const [client] = useState(() => new QueryClient({defaultOptions: {queries: {staleTime: 15_000, retry: 1, refetchOnWindowFocus: false}}}));
  return (
    <QueryClientProvider client={client}>
      <BrandProvider brand={brand}>
        {bare ? children : <PublicLayout>{children}</PublicLayout>}
        <Toaster position="bottom-center" richColors />
        <ConfirmHost />
      </BrandProvider>
    </QueryClientProvider>
  );
}
