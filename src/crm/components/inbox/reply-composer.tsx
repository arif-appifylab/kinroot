import {ChevronDown, Eye, FileText, Lock, MessageSquareReply, Send, StickyNote} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';

import {api} from '@/lib/api';
import {isEmptyHtml, textToEditorHtml} from '@/lib/email-html';
import {keys, useApiMutation, useEmailAccounts, useTemplates} from '@/lib/queries';
import type {ConversationDetail} from '@/lib/types';
import {cn} from '@/lib/utils';

import {EmailPreview, RichEditor} from '../email-editor';
import {MentionField} from '../mentions';
import {Button} from '../ui/button';
import {Card} from '../ui/card';
import {Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle} from '../ui/dialog';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger} from '../ui/menu';

export type ComposerMode = 'reply' | 'comment';

/**
 * Reply (an email through the normal send pipeline: merge fields, the
 * mailbox signature, threading headers, Reply-To) or Comment (internal, with
 * @mentions, never emailed). `focusKey` changes when a shortcut (r / c) asks
 * for the box.
 */
export function ReplyComposer({detail, mode, onMode, focusKey}: {detail: ConversationDetail; mode: ComposerMode; onMode: (m: ComposerMode) => void; focusKey: number}) {
  const t = detail.conversation;
  const accounts = useEmailAccounts();
  const templates = useTemplates();
  const [html, setHtml] = useState('');
  const [comment, setComment] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const invalidate = [keys.inbox, keys.timeline, keys.email];

  // Drafts belong to one conversation.
  useEffect(() => {
    setHtml('');
    setComment('');
  }, [t.id]);

  useEffect(() => {
    if (!focusKey) return;
    requestAnimationFrame(() => {
      const el = box.current?.querySelector<HTMLElement>(mode === 'reply' ? '.ProseMirror' : 'textarea');
      el?.focus();
    });
  }, [focusKey, mode]);

  const send = useApiMutation((close: boolean) => api.post(`/inbox/conversations/${t.id}/reply`, {html, close}), {
    invalidate,
    success: 'Reply sent',
    onSuccess: () => setHtml(''),
  });
  const addComment = useApiMutation(() => api.post(`/inbox/conversations/${t.id}/comments`, {body: comment}), {invalidate, success: 'Comment added', onSuccess: () => setComment('')});

  const account = (t.account && accounts.data?.find((a) => a.id === t.account!.id)) ?? accounts.data?.find((a) => a.isDefault) ?? accounts.data?.[0];
  const empty = isEmptyHtml(html);
  const canReply = detail.canReply && t.channel !== 'ticket';
  const submitComment = () => comment.trim() && !addComment.isPending && addComment.mutate(undefined);

  return (
    <Card className={cn('overflow-hidden', mode === 'comment' && 'ring-1 ring-amber-200')}>
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-100 px-3 py-2">
        {([['reply', MessageSquareReply, 'Reply'], ['comment', StickyNote, 'Comment']] as const).map(([m, Icon, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => onMode(m)}
            aria-pressed={mode === m}
            className={cn('inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors', mode === m ? (m === 'comment' ? 'bg-amber-50 text-amber-700' : 'bg-accent text-primary') : 'text-slate-500 hover:text-slate-800')}
          >
            <Icon className="size-3.5" /> {label}
          </button>
        ))}
        <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
          {mode === 'comment' ? (
            <span className="inline-flex items-center gap-1"><Lock className="size-3" /> Only your team sees comments · @ to mention</span>
          ) : detail.replyTo ? (
            `To ${detail.replyTo}${account ? ` · from ${account.fromEmail}` : ''}`
          ) : (
            'No address to reply to'
          )}
        </span>
      </div>
      <div ref={box} className="grid gap-2.5 p-3">
        {mode === 'comment' ? (
          <MentionField
            aria-label="Comment"
            value={comment}
            onChange={setComment}
            onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && submitComment()}
            rows={4}
            placeholder="Share context with your team. Type @ to mention someone. Never emailed."
            className="bg-amber-50/40"
          />
        ) : canReply ? (
          <>
            {detail.sidebar.contact?.emailOptOut && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">This contact opted out of email, so replies can't be sent.</p>}
            <RichEditor value={html} onChange={setHtml} compact placeholder="Write your reply… merge fields from the toolbar; your signature is added." ariaLabel="Reply" />
          </>
        ) : (
          <p className="rounded-lg bg-slate-50 px-3 py-3 text-sm text-muted-foreground">
            {t.channel === 'ticket' ? 'This conversation belongs to a ticket: reply from the ticket.' : 'There is no email address to reply to. Link a contact with an email address first.'}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {mode === 'reply' && canReply && (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="secondary" size="sm"><FileText /> Templates <ChevronDown /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
                  <DropdownMenuLabel>Insert a template</DropdownMenuLabel>
                  {templates.data?.map((tpl) => (
                    <DropdownMenuItem key={tpl.id} onSelect={() => setHtml(tpl.html || textToEditorHtml(tpl.body))}>
                      <span className="truncate">{tpl.name}</span>
                    </DropdownMenuItem>
                  ))}
                  {!templates.data?.length && <p className="px-2.5 py-2 text-sm text-muted-foreground">No templates yet</p>}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button type="button" variant="ghost" size="sm" onClick={() => setPreviewing(true)} disabled={empty}><Eye /> Preview</Button>
            </>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {mode === 'comment' ? (
              <Button type="button" size="sm" onClick={submitComment} disabled={!comment.trim()} pending={addComment.isPending} pendingLabel="Adding…">
                <StickyNote /> Add comment
              </Button>
            ) : (
              canReply && (
                <>
                  {t.status === 'OPEN' && (
                    <Button type="button" variant="secondary" size="sm" onClick={() => send.mutate(true)} disabled={empty || send.isPending || detail.sidebar.contact?.emailOptOut} pending={send.isPending && send.variables === true} pendingLabel="Sending…">Send & close</Button>
                  )}
                  <Button type="button" size="sm" onClick={() => send.mutate(false)} disabled={empty || send.isPending || detail.sidebar.contact?.emailOptOut} pending={send.isPending && send.variables === false} pendingLabel="Sending…">
                    <Send /> Send
                  </Button>
                </>
              )
            )}
          </div>
        </div>
      </div>
      {previewing && (
        <Dialog open onOpenChange={(o) => !o && setPreviewing(false)}>
          <DialogContent size="lg">
            <DialogHeader><DialogTitle>Preview</DialogTitle></DialogHeader>
            <DialogBody>
              <EmailPreview html={html} subject={/^re:/i.test(t.subject) ? t.subject : `Re: ${t.subject}`} layout="plain" signatureHtml={account?.signatureHtml || (account?.signature ? textToEditorHtml(account.signature) : null)} />
            </DialogBody>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}
