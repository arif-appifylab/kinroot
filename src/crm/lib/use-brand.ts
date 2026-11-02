import {useRouterState} from '@tanstack/react-router';

import {DEFAULT_BRAND, type Brand} from './brand';

/** The brand loaded by the root route (first match). */
export function useBrand(): Brand {
  return useRouterState({select: (s) => (s.matches[0]?.loaderData as Brand | undefined) ?? DEFAULT_BRAND});
}
