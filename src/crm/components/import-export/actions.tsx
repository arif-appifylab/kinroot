import {Download, Upload} from 'lucide-react';
import {useState} from 'react';

import {Button} from '@/components/ui/button';
import type {IoEntity} from '@/lib/import-export';
import {useMe} from '@/lib/queries';

import {ExportDrawer} from './export-drawer';
import {ImportDrawer} from './import-drawer';

/**
 * The Import and Export buttons of a list page (and a list's page), with their
 * drawers. `importId` (from a notification link, `?importId=`) opens the
 * import drawer on that import; `onImportClosed` lets the page drop it from the URL.
 */
export function ImportExportActions({entity, filters, listId, scopeLabel, importId, onImportClosed, canImport = true}: {
  entity: IoEntity;
  filters: Record<string, string | undefined>;
  listId?: string;
  scopeLabel: string;
  importId?: string;
  onImportClosed?: () => void;
  canImport?: boolean;
}) {
  const {canEdit} = useMe();
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const importOpen = importing || !!importId;
  return (
    <>
      {canEdit && canImport && <Button variant="secondary" size="sm" className="h-9" onClick={() => setImporting(true)}><Upload /> Import</Button>}
      <Button variant="secondary" size="sm" className="h-9" onClick={() => setExporting(true)}><Download /> Export</Button>
      {canEdit && canImport && (
        <ImportDrawer
          entity={entity}
          listId={listId}
          importId={importId}
          open={importOpen}
          onOpenChange={(o) => {
            setImporting(o);
            if (!o) onImportClosed?.();
          }}
        />
      )}
      <ExportDrawer entity={entity} open={exporting} onOpenChange={setExporting} filters={filters} listId={listId} scopeLabel={scopeLabel} />
    </>
  );
}
