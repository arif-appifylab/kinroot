import {Link} from '@tanstack/react-router';

import {Field, NativeSelect} from '../ui/form';
import {useBookingLinks} from './hooks';

/** Form builder: which booking link a "Booking slot" field offers times from. */
export function BookingLinkField({value, onChange}: {value?: string; onChange: (id: string | undefined) => void}) {
  const links = useBookingLinks();
  const rows = links.data ?? [];
  return (
    <Field
      label="Booking link"
      hint={
        rows.length ? (
          'Respondents pick an open time; submitting books it for them.'
        ) : (
          <>No booking links yet. <Link to="/meetings" search={{tab: 'links'}} className="font-semibold text-primary hover:underline">Create one</Link> first.</>
        )
      }
    >
      <NativeSelect value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">Choose a booking link</option>
        {rows.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name} ({l.kind === 'team' ? 'team' : l.user?.name ?? 'personal'}){l.active ? '' : ' · off'}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}
