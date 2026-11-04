import {useQuery} from '@tanstack/react-query';
import {Download, File, FileImage, FileSpreadsheet, FileText, Link2, MoreHorizontal, Paperclip, Trash2, Upload} from 'lucide-react';
import {useRef, useState} from 'react';
import {toast} from 'sonner';

import {api} from '@/lib/api';
import {ago} from '@/lib/format';
import {keys, useApiMutation, useMe} from '@/lib/queries';
import type {FileMeta} from '@/lib/types';
import {cn} from '@/lib/utils';

import {Button} from './ui/button';
import {Card} from './ui/card';
import {confirm} from './ui/confirm';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger} from './ui/menu';
import {uploadFile} from '@/lib/upload';

type RecordLink = {contactId?: string; companyId?: string; dealId?: string};

const MAX_BYTES = 5 * 1024 * 1024;

export const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function fileIcon(mime: string) {
  if (mime.startsWith('image/')) return FileImage;
  if (mime.includes('sheet') || mime.includes('csv') || mime.includes('excel')) return FileSpreadsheet;
  if (mime.startsWith('text/') || mime.includes('pdf') || mime.includes('word') || mime.includes('document')) return FileText;
  return File;
}

/** Files attached to a contact, company or deal (stored in the database, 5 MB each). */
export function AttachmentsCard({record}: {record: RecordLink}) {
  const {me, isAdmin, canEdit} = useMe();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const queryKey = [...keys.files, record];
  const files = useQuery({queryKey, queryFn: () => api.get<{rows: FileMeta[]}>('/files', record)});

  const remove = useApiMutation((id: string) => api.del(`/files/${id}`), {invalidate: [keys.files, keys.timeline], success: 'File deleted'});

  async function upload(list: FileList | File[]) {
    const picked = [...list];
    const tooBig = picked.filter((f) => f.size > MAX_BYTES);
    if (tooBig.length) toast.error(`${tooBig.map((f) => f.name).join(', ')}: files can be up to 5 MB`);
    const ok = picked.filter((f) => f.size <= MAX_BYTES && f.size > 0);
    if (!ok.length) return;
    setUploading((n) => n + ok.length);
    let done = 0;
    for (const f of ok) {
      const link = Object.fromEntries(Object.entries(record).filter(([, v]) => !!v));
      try {
        await uploadFile('/files', f, link);
        done++;
      } catch (e) {
        toast.error(`${f.name}: ${(e as Error).message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    await files.refetch();
    if (done) toast.success(done === 1 ? 'File uploaded' : `${done} files uploaded`);
  }

  async function copyLink(f: FileMeta) {
    try {
      const {url} = await api.post<{url: string}>(`/files/${f.id}/link`, {days: 7});
      await navigator.clipboard.writeText(url);
      toast.success('Share link copied', {description: 'Anyone with the link can open it for 7 days.'});
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const rows = files.data?.rows ?? [];
  return (
    <Card
      className={cn('overflow-hidden transition-shadow', dragging && 'ring-2 ring-primary/40')}
      onDragOver={(e) => {
        if (!canEdit || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!canEdit) return;
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
      }}
    >
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-bold text-slate-900">Attachments{rows.length ? ` · ${rows.length}` : ''}</h2>
        {canEdit && (
          <Button variant="ghost" size="sm" onClick={() => input.current?.click()} pending={uploading > 0} pendingLabel="Uploading…">
            <Upload /> Add
          </Button>
        )}
        <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files && upload(e.target.files).finally(() => (e.target.value = ''))} />
      </div>
      <div className="px-1 py-1">
        {files.isLoading && <p className="px-3 py-3 text-sm text-muted-foreground">Loading…</p>}
        {files.isError && (
          <p role="alert" className="flex flex-wrap items-center gap-x-2 px-3 py-3 text-sm text-destructive">
            Files could not be loaded.
            <button type="button" className="cursor-pointer font-semibold text-primary hover:underline" onClick={() => files.refetch()}>Retry</button>
          </p>
        )}
        {!files.isLoading && !files.isError && rows.length === 0 && (
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => input.current?.click()}
            className="flex w-full cursor-pointer flex-col items-center gap-1 rounded-lg px-3 py-5 text-center text-sm text-muted-foreground transition-colors hover:bg-slate-50 disabled:cursor-default disabled:hover:bg-transparent"
          >
            <Paperclip className="size-5 text-slate-300" />
            {canEdit ? 'Drop files here or click to upload' : 'No files yet'}
            {canEdit && <span className="text-xs text-muted-foreground">Up to 5 MB each</span>}
          </button>
        )}
        {rows.map((f) => {
          const Icon = fileIcon(f.mimeType);
          return (
            <div key={f.id} className="group flex items-center gap-2.5 rounded-lg px-3 py-2 hover:bg-slate-50">
              <Icon className="size-4 shrink-0 text-slate-400" />
              <a href={`/site-api/crm/files/${f.id}`} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-800 hover:text-primary">{f.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {fileSize(f.size)} · {f.uploadedBy?.name ?? 'Someone'} · {ago(f.createdAt)}
                </p>
              </a>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100" pending={remove.isPending && remove.variables === f.id} aria-label={`Options for ${f.name}`}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem asChild>
                    <a href={`/site-api/crm/files/${f.id}?download=1`}><Download /> Download</a>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => copyLink(f)}><Link2 /> Copy share link</DropdownMenuItem>
                  {(f.uploadedBy?.id === me.id || isAdmin) && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem destructive onSelect={async () => (await confirm({title: `Delete ${f.name}?`, description: "This can't be undone.", confirmLabel: 'Delete', destructive: true})) && remove.mutate(f.id)}><Trash2 /> Delete</DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
