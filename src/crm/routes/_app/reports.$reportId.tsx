import {useQuery} from '@tanstack/react-query';
import {createFileRoute, Link} from '@tanstack/react-router';
import {BarChart3} from 'lucide-react';

import {ReportEditor} from '@/components/reports/editor';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {EmptyState, Skeleton} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {keys} from '@/lib/queries';
import type {SavedReport} from '@/lib/types';

export const Route = createFileRoute('/_app/reports/$reportId')({
  head: () => ({meta: [{title: pageTitle('Report')}]}),
  component: ReportPage,
});

function ReportPage() {
  const {reportId} = Route.useParams();
  const report = useQuery({queryKey: [...keys.reports, reportId], queryFn: () => api.get<{report: SavedReport}>(`/reports/${reportId}`), select: (d) => d.report, retry: false});
  if (report.isLoading) return <Skeleton className="h-[480px] rounded-xl" />;
  if (!report.data) {
    return (
      <Card>
        <EmptyState icon={<BarChart3 />} title="Report not found" description="It was deleted, or it is private to someone else." action={<Button asChild><Link to="/reports/saved">All reports</Link></Button>} />
      </Card>
    );
  }
  // Remount when the saved version changes so the editor starts from it.
  return <ReportEditor key={`${report.data.id}:${report.data.updatedAt}`} report={report.data} />;
}
