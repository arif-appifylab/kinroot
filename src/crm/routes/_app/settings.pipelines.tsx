import {createFileRoute} from '@tanstack/react-router';

import {PipelineManager} from '@/components/pipeline-editor';
import {AdminOnly} from '@/components/settings-section';
import {useMe} from '@/lib/queries';

export const Route = createFileRoute('/_app/settings/pipelines')({
  component: PipelineSettings,
});

function PipelineSettings() {
  const {isAdmin} = useMe();
  return (
    <div>
      {!isAdmin && <div className="mb-6"><AdminOnly /></div>}
      <PipelineManager />
    </div>
  );
}
