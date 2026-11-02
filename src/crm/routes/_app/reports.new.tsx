import {createFileRoute} from '@tanstack/react-router';

import {ReportEditor} from '@/components/reports/editor';
import {pageTitle} from '@/lib/brand';

export const Route = createFileRoute('/_app/reports/new')({
  head: () => ({meta: [{title: pageTitle('New report')}]}),
  component: () => <ReportEditor />,
});
