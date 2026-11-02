import {useQuery} from '@tanstack/react-query';
import {toast} from 'sonner';

import {api} from '@/lib/api';
import {keys} from '@/lib/queries';
import type {BookingLinkRow, CalendarState, SchedulingProfile} from '@/lib/types';

export function useBookingLinks() {
  return useQuery({queryKey: [...keys.scheduling, 'links'], queryFn: () => api.get<{rows: BookingLinkRow[]}>('/scheduling/links'), select: (d) => d.rows});
}

/** My calendar connections and whether the Google / Microsoft apps are set up. */
export function useCalendarState() {
  return useQuery({queryKey: keys.calendar, queryFn: () => api.get<CalendarState>('/calendar'), staleTime: 60_000});
}

/** My booking handle + default timezone (created on first use with the browser's timezone). */
export function useSchedulingProfile() {
  return useQuery({
    queryKey: [...keys.scheduling, 'profile'],
    queryFn: () => api.get<{profile: SchedulingProfile; baseUrl: string}>('/scheduling/profile', {tz: Intl.DateTimeFormat().resolvedOptions().timeZone}),
    staleTime: 5 * 60_000,
  });
}

export function copyText(text: string, what = 'Copied') {
  navigator.clipboard.writeText(text);
  toast.success(what);
}
