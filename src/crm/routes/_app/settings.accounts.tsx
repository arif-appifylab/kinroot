import {useInfiniteQuery, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {createFileRoute} from '@tanstack/react-router';
import {Ban, KeyRound, Loader2, LogOut, MoreHorizontal, RotateCcw, Search, ShieldCheck, UserCog} from 'lucide-react';
import {type FormEvent, useState} from 'react';
import {toast} from 'sonner';

import {type Column, DataTable} from '@/components/data-table';
import {SettingsSection} from '@/components/settings-section';
import {ErrorNote, LoadMore, NoSiteAccess} from '@/components/site-admin/common';
import {UserRolesDialog} from '@/components/site-admin/user-roles-dialog';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {confirm} from '@/components/ui/confirm';
import {Input, Label} from '@/components/ui/form';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger} from '@/components/ui/menu';
import {Avatar, EmptyState, Skeleton, Tabs, TabsList, TabsTrigger} from '@/components/ui/misc';
import {pageTitle} from '@/lib/brand';
import {ago, dateTime, shortDate} from '@/lib/format';
import {type AdminUser, siteApi, siteKeys, siteRolesQuery, siteUsersQuery, type StatusFilter, useSiteMe} from '@/lib/site-admin';

export const Route = createFileRoute('/_app/settings/accounts')({
  head: () => ({meta: [{title: pageTitle('Accounts')}]}),
  component: AccountsSettings,
});

const STATUS_TABS: {value: 'all' | Exclude<StatusFilter, ''>; label: string}[] = [
  {value: 'all', label: 'All'},
  {value: 'active', label: 'Active'},
  {value: 'suspended', label: 'Blocked'},
];

/** DataTable keys rows by a string id; `userId` is the account's number. */
type TableRow = Omit<AdminUser, 'id'> & {id: string; userId: number};

/**
 * Everyone with an account on this site: the CRM team AND support-portal customers. The site's own
 * admin API (`/site-api/admin/users`), gated by the SITE permissions, as the template's Users screen
 * was: listing needs site:user:read, every action site:user:update, roles also site:role:read. The
 * server refuses anything that would act on someone with more access than you. Addresses come from
 * the server already masked for everyone but their owner and the site's owner.
 */
function AccountsSettings() {
  const {loading, error, abilities, viewerId, isOwner, query: meQuery} = useSiteMe();

  if (loading) {
    return (
      <SettingsSection title="Accounts">
        <div className="grid gap-3">{Array.from({length: 4}, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
      </SettingsSection>
    );
  }
  if (error) {
    return (
      <SettingsSection title="Accounts">
        <ErrorNote error={error} onRetry={() => void meQuery.refetch()} />
      </SettingsSection>
    );
  }
  if (!abilities?.manageUsers) {
    return (
      <SettingsSection title="Accounts" description="Everyone with an account on this site.">
        <NoSiteAccess>Only the site’s owner and people whose site role lets them see users can open this list.</NoSiteAccess>
      </SettingsSection>
    );
  }
  return <AccountsList canUpdate={abilities.updateUsers} canRoles={abilities.manageRoles} viewerId={viewerId} isOwner={isOwner} />;
}

function AccountsList({canUpdate, canRoles, viewerId, isOwner}: {canUpdate: boolean; canRoles: boolean; viewerId: number | null; isOwner: boolean}) {
  const qc = useQueryClient();
  const [emailDraft, setEmailDraft] = useState('');
  const [filter, setFilter] = useState<{email: string; status: StatusFilter}>({email: '', status: ''});
  const [editing, setEditing] = useState<AdminUser | null>(null);

  const users = useInfiniteQuery(siteUsersQuery(filter));
  // Role names for the badges; only people who may see roles can read them.
  const roles = useQuery({...siteRolesQuery, enabled: canRoles});
  const roleNames = new Map(roles.data?.roles.map((r) => [r.slug, r.name]));
  const refresh = () => qc.invalidateQueries({queryKey: siteKeys.users});

  const setStatus = useMutation({
    mutationFn: ({user, status}: {user: AdminUser; status: 'active' | 'suspended'}) => siteApi.patch(`/admin/users/${user.id}`, {status}),
    onSuccess: (_r, {user, status}) => (void refresh(), toast.success(status === 'suspended' ? `${user.name} is blocked and signed out.` : `${user.name} can sign in again.`)),
    onError: (e) => toast.error(e.message),
  });
  const endSessions = useMutation({
    mutationFn: (user: AdminUser) => siteApi.post(`/admin/users/${user.id}/sessions/revoke`),
    onSuccess: (_r, user) => toast.success(`${user.name} is signed out everywhere.`),
    onError: (e) => toast.error(e.message),
  });
  // Lost phone and recovery codes: they set two-step sign-in up again after their next sign-in.
  const disableTwoFactor = useMutation({
    mutationFn: (user: AdminUser) => siteApi.post(`/admin/users/${user.id}/two-factor/disable`),
    onSuccess: (_r, user) => (void refresh(), toast.success(`Two-step sign-in is off for ${user.name}.`)),
    onError: (e) => toast.error(e.message),
  });
  const busyId = (setStatus.isPending && setStatus.variables?.user.id) || (endSessions.isPending && endSessions.variables?.id) || (disableTwoFactor.isPending && disableTwoFactor.variables?.id) || null;

  const askStatus = async (user: AdminUser) => {
    const block = user.status === 'active';
    const ok = await confirm(
      block
        ? {title: `Block ${user.name}?`, description: 'They are signed out at once and cannot sign in, to the CRM or the support portal, until you unblock them.', confirmLabel: 'Block', destructive: true}
        : {title: `Unblock ${user.name}?`, description: 'They can sign in again with their usual details.', confirmLabel: 'Unblock'},
    );
    if (ok) setStatus.mutate({user, status: block ? 'suspended' : 'active'});
  };
  const askEndSessions = async (user: AdminUser) => {
    const ok = await confirm({title: `Sign ${user.name} out everywhere?`, description: 'Every device they are signed in on is signed out. They can sign in again.', confirmLabel: 'End sessions'});
    if (ok) endSessions.mutate(user);
  };
  const askDisableTwoFactor = async (user: AdminUser) => {
    const ok = await confirm({
      title: `Turn off two-step sign-in for ${user.name}?`,
      description: 'For someone who lost their phone and their recovery codes. They sign in with their password or an emailed code, then can set it up again.',
      confirmLabel: 'Turn it off',
      destructive: true,
    });
    if (ok) disableTwoFactor.mutate(user);
  };

  const search = (e: FormEvent) => {
    e.preventDefault();
    setFilter((f) => ({...f, email: emailDraft.trim()}));
  };

  const rows: TableRow[] | undefined = users.data?.pages.flatMap((p) => p.users).map((u) => ({...u, id: String(u.id), userId: u.id}));
  const asUser = (r: TableRow): AdminUser => ({...r, id: r.userId});
  const filtered = Boolean(filter.email || filter.status);

  const columns: Column<TableRow>[] = [
    {
      key: 'person',
      header: 'Account',
      cell: (u) => (
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={u.name} size="sm" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-slate-900">
                {u.name}
                {u.userId === viewerId && ' (you)'}
              </span>
              {!u.emailVerified && <Badge tone="amber">Unconfirmed</Badge>}
            </div>
            <p className="truncate text-xs text-muted-foreground">{u.email}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'roles',
      header: 'Roles',
      cell: (u) =>
        u.roles.length ? (
          <span className="flex flex-wrap gap-1">
            {u.roles.map((slug) => (
              <Badge key={slug} tone={slug === 'owner' ? 'violet' : slug === 'admin' ? 'blue' : 'neutral'}>
                {roleNames.get(slug) ?? slug}
              </Badge>
            ))}
          </span>
        ) : (
          <span className="text-muted-foreground">None</span>
        ),
    },
    {
      key: 'twoFactor',
      header: 'Two-step',
      hideBelow: 'lg',
      cell: (u) => (u.twoFactor ? <Badge tone="green">On</Badge> : <span className="text-muted-foreground">Off</span>),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (u) => (u.status === 'suspended' ? <Badge tone="rose">Blocked</Badge> : <Badge tone="green">Active</Badge>),
    },
    {
      key: 'last',
      header: 'Last sign-in',
      hideBelow: 'md',
      cell: (u) =>
        u.lastLoginAt ? (
          <time className="whitespace-nowrap text-muted-foreground" dateTime={u.lastLoginAt} title={dateTime(u.lastLoginAt)}>
            {ago(u.lastLoginAt)}
          </time>
        ) : (
          <span className="text-muted-foreground">Never</span>
        ),
    },
    {
      key: 'joined',
      header: 'Joined',
      hideBelow: 'xl',
      cell: (u) => (
        <time className="whitespace-nowrap text-muted-foreground" dateTime={u.createdAt}>
          {shortDate(u.createdAt)}
        </time>
      ),
    },
  ];

  if (canUpdate) {
    columns.push({
      key: 'actions',
      header: '',
      className: 'w-12 text-right',
      cell: (r) => {
        const u = asUser(r);
        const self = u.id === viewerId;
        const busy = busyId === u.id;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={busyId !== null}>
              <Button variant="ghost" size="icon-sm" aria-label={busy ? `Working on ${u.name}…` : `Actions for ${u.name}`} aria-busy={busy || undefined}>
                {busy ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {canRoles && (
                <DropdownMenuItem onSelect={() => setEditing(u)}>
                  <ShieldCheck /> Edit roles
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => void askEndSessions(u)}>
                <LogOut /> End sessions
              </DropdownMenuItem>
              {u.twoFactor && !self && (
                <DropdownMenuItem onSelect={() => void askDisableTwoFactor(u)}>
                  <KeyRound /> Turn off two-step sign-in
                </DropdownMenuItem>
              )}
              {!self && (
                <>
                  <DropdownMenuSeparator />
                  {u.status === 'active' ? (
                    <DropdownMenuItem destructive onSelect={() => void askStatus(u)}>
                      <Ban /> Block
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onSelect={() => void askStatus(u)}>
                      <RotateCcw /> Unblock
                    </DropdownMenuItem>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    });
  }

  return (
    <>
      <SettingsSection
        title="Accounts"
        description="Everyone with an account on this site: your team and your support-portal customers. Blocking someone signs them out and keeps them out until you unblock them."
      >
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {/* Looking people up by address is the site owner's alone (the server refuses anyone else). */}
          {isOwner ? (
            <form role="search" noValidate onSubmit={search} className="flex flex-wrap items-center gap-2">
              <Label htmlFor="accounts-email" className="text-[13px]">
                Find by exact email
              </Label>
              <Input
                id="accounts-email"
                type="email"
                size="sm"
                className="w-full sm:w-64"
                value={emailDraft}
                maxLength={254}
                autoComplete="off"
                placeholder="maya@example.com"
                onChange={(e) => {
                  setEmailDraft(e.target.value);
                  // Emptied: everyone again.
                  if (!e.target.value && filter.email) setFilter((f) => ({...f, email: ''}));
                }}
              />
              <Button type="submit" variant="secondary" size="sm">
                <Search /> Find
              </Button>
            </form>
          ) : (
            <span />
          )}
          <Tabs value={filter.status || 'all'} onValueChange={(v) => setFilter((f) => ({...f, status: v === 'all' ? '' : (v as StatusFilter)}))}>
            <TabsList size="sm" aria-label="Status">
              {STATUS_TABS.map((t) => (
                <TabsTrigger key={t.value} value={t.value}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {users.error && !rows?.length ? (
          <ErrorNote error={users.error} onRetry={() => void users.refetch()} />
        ) : (
          <div className="-mx-5">
            <DataTable
              rows={rows}
              columns={columns}
              loading={users.isPending}
              empty={
                filtered ? (
                  <EmptyState
                    icon={<Search />}
                    title={filter.email ? 'No account has that email' : 'No accounts match'}
                    description={filter.email ? 'Check the spelling: the search needs the whole address.' : 'Try another status.'}
                    action={
                      <Button variant="secondary" size="sm" onClick={() => (setEmailDraft(''), setFilter({email: '', status: ''}))}>
                        Show everyone
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState icon={<UserCog />} title="No accounts yet" description="People show here once they sign up." />
                )
              }
            />
          </div>
        )}
        {users.error && rows?.length ? <div className="mt-4"><ErrorNote error={users.error} /></div> : null}
        <LoadMore hasNextPage={users.hasNextPage} isFetchingNextPage={users.isFetchingNextPage} fetchNextPage={users.fetchNextPage} />
      </SettingsSection>

      {editing && (
        <UserRolesDialog
          key={editing.id}
          user={editing}
          self={editing.id === viewerId}
          onClose={() => setEditing(null)}
          onSaved={() => {
            toast.success(`Roles saved for ${editing.name}.`);
            const self = editing.id === viewerId;
            setEditing(null);
            void refresh();
            void qc.invalidateQueries({queryKey: siteKeys.roles});
            // Your own roles changed: what these screens may show you changed too.
            if (self) void qc.invalidateQueries({queryKey: siteKeys.me});
          }}
        />
      )}
    </>
  );
}
