import {useRouterState} from '@tanstack/react-router';
import {createContext, createElement, useContext, type ReactNode} from 'react';

import {DEFAULT_BRAND, setCurrentBrand, type Brand} from './brand';

/**
 * Public pages (src/pages/f, /chat, …) are React islands without the CRM's router: they pass the
 * brand the page read on the server through this context instead.
 */
const BrandContext = createContext<Brand | null>(null);

export function BrandProvider({brand, children}: {brand: Brand; children: ReactNode}) {
  setCurrentBrand(brand);
  return createElement(BrandContext.Provider, {value: brand}, children);
}

/** The brand: a public page's (BrandProvider), else the one loaded by the CRM's root route. */
export function useBrand(): Brand {
  const given = useContext(BrandContext);
  // A tree has a provider or it doesn't, for its whole life: the hooks below run the same way every render.
  if (given) return given;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useRouterState({select: (s) => (s.matches[0]?.loaderData as Brand | undefined) ?? DEFAULT_BRAND});
}
