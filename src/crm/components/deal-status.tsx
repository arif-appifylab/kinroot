import {useState} from 'react';

import {useSettings} from '@/lib/queries';

import {Button} from './ui/button';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from './ui/dialog';
import {Input} from './ui/form';
import {cn} from '@/lib/utils';

/** Losing a deal always asks why: the "Why we lose" report depends on it. */
export function LostDialog({onClose, onConfirm}: {onClose: () => void; onConfirm: (reason: string) => void}) {
  const settings = useSettings();
  const [reason, setReason] = useState('');
  const [other, setOther] = useState('');
  const final = reason === '__other' ? other.trim() : reason;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Why was this deal lost?</DialogTitle>
          <DialogDescription>Reasons roll up into your dashboard so you can see patterns.</DialogDescription>
        </DialogHeader>
        <DialogBody className="gap-2">
          {[...(settings.data?.settings.lostReasons ?? []), '__other'].map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setReason(r)}
              className={cn(
                'cursor-pointer rounded-xl border px-4 py-2.5 text-left text-sm font-medium transition-all',
                reason === r ? 'border-primary bg-accent text-accent-foreground ring-2 ring-primary/15' : 'border-border text-slate-700 hover:border-slate-300',
              )}
            >
              {r === '__other' ? 'Something else…' : r}
            </button>
          ))}
          {reason === '__other' && <Input autoFocus value={other} onChange={(e) => setOther(e.target.value)} placeholder="Describe the reason" />}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={!final} onClick={() => onConfirm(final)}>Mark as lost</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
