import {useQueryClient} from '@tanstack/react-query';
import {useNavigate} from '@tanstack/react-router';
import {toast} from 'sonner';

import {api} from '@/lib/api';
import {recordKeys} from '@/lib/queries';
import type {RestoreResult} from '@/lib/types';

/**
 * Toast after a delete that went to the recycle bin, with "Undo" (restores
 * right away and opens the record again). Pass the `binId` the DELETE returned.
 */
export function useBinToast() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return (noun: string, binId: string | null | undefined, opts: {reopen?: boolean} = {}) => {
    if (!binId) return void toast.success(`${noun} deleted`);
    toast.success(`${noun} moved to the recycle bin`, {
      description: 'You can restore it for 30 days from Settings → Recycle bin.',
      action: {
        label: 'Undo',
        onClick: async () => {
          try {
            const {restored} = await api.post<{restored: RestoreResult}>(`/recycle-bin/${binId}/restore`);
            await Promise.all([...recordKeys, ['lists'], ['forms'], ['tickets']].map((queryKey) => qc.invalidateQueries({queryKey})));
            toast.success(`${noun} restored`, restored.warning ? {description: restored.warning} : undefined);
            if (opts.reopen !== false) navigate({href: restored.path});
          } catch (e) {
            toast.error((e as Error).message);
          }
        },
      },
    });
  };
}
