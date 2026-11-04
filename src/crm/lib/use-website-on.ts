import {useEffect, useState} from 'react';

import {api} from './api';

/** One read per page load: whether the public website is on (Settings → Website). */
let read: Promise<boolean> | null = null;

/**
 * True once the public website is known to be on. Off, `/` sends visitors straight to sign-in, so a
 * "Back to the website" link would go round in a circle (AUDIT-2 L-18): hide it until this says on.
 */
export function useWebsiteOn(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    read ??= api.get<{enabled?: boolean}>('/public/website').then(
      (w) => w.enabled !== false,
      () => false,
    );
    void read.then((value) => live && setOn(value));
    return () => {
      live = false;
    };
  }, []);
  return on;
}
