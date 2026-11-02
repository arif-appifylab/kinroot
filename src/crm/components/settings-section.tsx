import type {ReactNode} from 'react';

import {Card} from './ui/card';

export function SettingsSection({title, description, children, actions}: {title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode}) {
  return (
    <Card className="mb-6 overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-bold text-slate-900">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex gap-2">{actions}</div>}
      </div>
      <div className="p-5">{children}</div>
    </Card>
  );
}

export function AdminOnly() {
  return <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">Only admins can change these settings.</p>;
}
