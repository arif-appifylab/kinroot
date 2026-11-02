import {useQuery} from '@tanstack/react-query';

import {api} from '@/lib/api';
import {keys} from '@/lib/queries';
import type {DashboardRow, SavedReport} from '@/lib/types';

export function useDashboards() {
  return useQuery({queryKey: keys.dashboards, queryFn: () => api.get<{rows: DashboardRow[]}>('/dashboards'), select: (d) => d.rows});
}

export function useSavedReports() {
  return useQuery({queryKey: [...keys.reports, 'list'], queryFn: () => api.get<{rows: SavedReport[]}>('/reports'), select: (d) => d.rows});
}
