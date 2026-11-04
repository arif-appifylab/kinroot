import {useInfiniteQuery, useQuery} from '@tanstack/react-query';
import {createFileRoute} from '@tanstack/react-router';
import {Check, Copy, Link2, Loader2, MoreHorizontal, RotateCcw, Search, UserMinus, UserPlus, Users, UserRound, X} from 'lucide-react';
import {type FormEvent, useEffect, useState} from 'react';
import {toast} from 'sonner';
import {z} from 'zod';

import {type Column, DataTable, LoadError} from '@/components/data-table';
import {AdminOnly, SettingsSection} from '@/components/settings-section';
import {type AccountActions, AccountMenuItems, useAccountActions, useSiteAccount} from '@/components/site-admin/account-actions';
import {ErrorNote, LoadMore} from '@/components/site-admin/common';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {confirm} from '@/components/ui/confirm';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Field, Input, Label, NativeSelect} from '@/components/ui/form';
import {is, useFormState} from '@/components/ui/form-state';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger} from '@/components/ui/menu';
import {Avatar, EmptyState, Skeleton, Tabs, TabsList, TabsTrigger} from '@/components/ui/misc';
import {api} from '@/lib/api';
import {pageTitle} from '@/lib/brand';
import {ago, dateTime, shortDate} from '@/lib/format';
import {keys, useApiMutation, useMe, useTeam} from '@/lib/queries';
import {type AdminUser, siteRolesQuery, siteUsersQuery, type StatusFilter, useSiteMe} from '@/lib/site-admin';
import type {Me, Role} from '@/lib/types';

export const Route = createFileRoute('/_app/settings/team')({
  head: () => ({meta: [{title: pageTitle('Team')}]}),
  validateSearch: z.object({tab: z.enum(['team', 'customers']).optional()}),
  component: TeamSettings,
});

const ROLES: Record<Role, {label: string; desc: string}> = {
  OWNER: {label: 'Owner', desc: 'Full access, cannot be removed'},
  ADMIN: {label: 'Admin', desc: 'Manage settings, team and all records'},
  MEMBER: {label: 'Member', desc: 'Create and edit records'},
  VIEWER: {label: 'Viewer', desc: 'Read-only'},
};
const ASSIGNABLE = ['ADMIN', 'MEMBER', 'VIEWER'] as const;

/**
 * Settings → Team, one screen for everyone with access (owner request, 4 Nov; it was Team and Accounts):
 *
 * - **Team**: the CRM's members and pending invites (`/site-api/crm/team`). Each row's ⋯ menu has the
 *   team actions (role, deactivate, invite link, cancel invite) for admins, and, for people whose
 *   site role lets them manage users, that member's sign-in account actions (block, sign out
 *   everywhere, two-step reset, site roles), read when the menu opens.
 * - **Customers**: the site's other accounts, support-portal customers (`/site-api/admin/users`
 *   without the team's accounts), with the same account actions. Only with `manageUsers`.
 *
 * Every permission is checked again on the server; these checks only decide what is shown. The site
 * owner's row says "Account owner" and has no actions (the server refuses them too).
 */
function TeamSettings() {
  const {tab = 'team'} = Route.useSearch();
  const navigate = Route.useNavigate();
  const site = useSiteMe();
  const canAccounts = Boolean(site.abilities?.manageUsers);
  const showCustomers = tab === 'customers' && canAccounts;

  return (
    <div>
      {canAccounts && (
        <Tabs value={showCustomers ? 'customers' : 'team'} onValueChange={(v) => navigate({search: {tab: v === 'customers' ? 'customers' : undefined}, replace: true})} className="mb-4">
          <TabsList aria-label="People">
            <TabsTrigger value="team">
              <Users /> Team
            </TabsTrigger>
            <TabsTrigger value="customers">
              <UserRound /> Customers
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      {showCustomers ? <CustomersTab /> : <TeamTab />}
    </div>
  );
}

// ─── Team ───

function InviteLink({url, onClose}: {url: string; onClose: () => void}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Share this invite link</DialogTitle>
          <DialogDescription>Send it to your teammate over chat or email. They sign in (or create their account) with the invited address, then join. It works once, for 14 days.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex gap-2">
            <Input readOnly value={url} className="font-mono text-xs" onFocus={(e) => e.target.select()} aria-label="Invite link" />
            <Button
              variant="secondary"
              size="icon"
              aria-label="Copy link"
              onClick={() =>
                navigator.clipboard.writeText(url).then(
                  () => toast.success('Link copied'),
                  () => toast.error('Copying was blocked: select the link and copy it yourself.'),
                )
              }
            >
              <Copy />
            </Button>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TeamTab() {
  const {me, isAdmin} = useMe();
  const team = useTeam();
  const site = useSiteMe();
  const accountActions = useAccountActions(site.viewerId);
  const canAccountActions = Boolean(site.abilities?.updateUsers);
  const canRoles = Boolean(site.abilities?.manageRoles);
  const [inviting, setInviting] = useState(false);
  const [form, setForm] = useState({name: '', email: '', role: 'MEMBER'});
  const [link, setLink] = useState<string | null>(null);

  const invite = useApiMutation(() => api.post<{inviteUrl: string}>('/team/invite', form), {
    invalidate: [keys.team],
    onSuccess: (r) => (setInviting(false), setForm({name: '', email: '', role: 'MEMBER'}), f.reset(), setLink(r.inviteUrl)),
  });
  const update = useApiMutation(({id, ...patch}: {id: string; role?: string; active?: boolean}) => api.patch(`/team/${id}`, patch), {invalidate: [keys.team], success: 'Updated'});
  const relink = useApiMutation((id: string) => api.post<{inviteUrl: string}>(`/team/${id}/invite-link`), {onSuccess: (r) => setLink(r.inviteUrl)});
  const cancelInvite = useApiMutation((id: string) => api.del<{ok: true}>(`/team/${id}`), {invalidate: [keys.team], success: 'Invite cancelled'});
  const f = useFormState(form, {
    name: [is.required('Enter their name.'), is.maxLength(80)],
    email: [is.required('Enter the email address they sign in with.'), is.email(), is.maxLength(254)],
  });
  const closeInvite = () => (setInviting(false), f.reset());

  // One action at a time per row: its menu shows a spinner, the other rows' menus wait.
  const busyMember =
    (update.isPending && update.variables?.id) || (relink.isPending && relink.variables) || (cancelInvite.isPending && cancelInvite.variables) || null;
  const busyAccount = accountActions.busyId;
  const anyBusy = busyMember !== null || busyAccount !== null;

  const askDeactivate = async (u: Me) => {
    const ok = await confirm({
      title: `Deactivate ${u.name}?`,
      description: 'They lose access to the CRM on their next click. Their records keep them as owner. You can reactivate them any time.',
      confirmLabel: 'Deactivate',
      destructive: true,
    });
    if (ok) update.mutate({id: u.id, active: false});
  };
  const askCancelInvite = async (u: Me) => {
    const ok = await confirm({
      title: `Cancel the invite for ${u.name}?`,
      description: 'The link stops working at once. Invite them again if you change your mind.',
      confirmLabel: 'Cancel invite',
      cancelLabel: 'Keep it',
      destructive: true,
    });
    if (ok) cancelInvite.mutate(u.id);
  };

  const active = team.data?.filter((u) => u.active).length ?? 0;
  const pending = team.data?.filter((u) => u.active && u.invited).length ?? 0;

  return (
    <div>
      {!isAdmin && (
        <div className="mb-6">
          <AdminOnly />
        </div>
      )}
      <SettingsSection
        title="Team"
        description={team.data ? `${active} active member${active === 1 ? '' : 's'}${pending ? `, ${pending} invite${pending === 1 ? '' : 's'} pending` : ''}` : 'Everyone who works in the CRM.'}
        actions={
          isAdmin && (
            <Button size="sm" onClick={() => setInviting(true)}>
              <UserPlus /> Invite
            </Button>
          )
        }
      >
        {team.isError ? (
          <LoadError error={team.error} onRetry={() => void team.refetch()} />
        ) : team.isPending ? (
          <div className="grid gap-3" aria-busy="true">
            {Array.from({length: 4}, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {team.data.map((u) => {
              const self = u.id === me.id;
              // The team actions, exactly as before the merge: admins, never on an Owner or yourself.
              const memberActions = isAdmin && u.role !== 'OWNER' && !self && !u.accountOwner;
              // The account's actions: only with the site permission, only for someone who has joined.
              const accountMenu = canAccountActions && !u.accountOwner && u.accountId != null;
              const busy = busyMember === u.id || (busyAccount !== null && busyAccount === u.accountId);
              return (
                <li key={u.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <Avatar name={u.name} color={u.color} src={u.avatarUrl} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-slate-900">
                        {u.name}
                        {self && ' (you)'}
                      </p>
                      {u.invited && u.active && <Badge tone="amber">Invite pending</Badge>}
                      {!u.active && <Badge tone="neutral">{u.invited ? 'Invite switched off' : 'Deactivated'}</Badge>}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {u.accountOwner ? 'Account owner' : u.email} · {u.invited ? 'not joined yet' : u.lastSeenAt ? `last seen ${ago(u.lastSeenAt)}` : 'never signed in'}
                    </p>
                  </div>
                  <Badge tone={u.role === 'OWNER' ? 'violet' : u.role === 'ADMIN' ? 'blue' : 'neutral'}>{ROLES[u.role].label}</Badge>
                  {memberActions || accountMenu ? (
                    <MemberMenu
                      member={u}
                      busy={busy}
                      disabled={anyBusy}
                      memberActions={memberActions}
                      accountMenu={accountMenu}
                      canRoles={canRoles}
                      accountActions={accountActions}
                      onRole={(role) => update.mutate({id: u.id, role})}
                      onReactivate={() => update.mutate({id: u.id, active: true})}
                      onDeactivate={() => void askDeactivate(u)}
                      onLink={() => relink.mutate(u.id)}
                      onCancelInvite={() => void askCancelInvite(u)}
                    />
                  ) : (
                    // Keeps the badges in one column when a row has no menu.
                    <span className="size-8 shrink-0" aria-hidden />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </SettingsSection>

      <SettingsSection title="Team roles" description="What each role can do in the CRM. Site roles (Settings → Roles) decide who may manage sign-in accounts.">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {Object.entries(ROLES).map(([k, r]) => (
            <div key={k} className="rounded-xl bg-slate-50 p-3">
              <p className="text-sm font-semibold text-slate-900">{r.label}</p>
              <p className="text-xs text-muted-foreground">{r.desc}</p>
            </div>
          ))}
        </div>
      </SettingsSection>

      {inviting && (
        <Dialog open onOpenChange={(o) => !o && !invite.isPending && closeInvite()}>
          <DialogContent size="sm">
            <form {...f.form(() => invite.mutate(undefined, {onError: f.fail}))} className="flex min-h-0 flex-1 flex-col">
              <DialogHeader>
                <DialogTitle>Invite a teammate</DialogTitle>
              </DialogHeader>
              <DialogBody>
                <Field label="Name" htmlFor="i-name" error={f.error('name')}>
                  <Input id="i-name" autoFocus maxLength={80} value={form.name} onChange={(e) => setForm({...form, name: e.target.value})} onBlur={f.blur('name')} />
                </Field>
                <Field label="Email" htmlFor="i-email" error={f.error('email')}>
                  <Input id="i-email" type="email" maxLength={254} value={form.email} onChange={(e) => setForm({...form, email: e.target.value})} onBlur={f.blur('email')} />
                </Field>
                <Field label="Role" htmlFor="i-role" hint={ROLES[form.role as Role].desc}>
                  <NativeSelect id="i-role" value={form.role} onChange={(e) => setForm({...form, role: e.target.value})}>
                    {ASSIGNABLE.map((r) => (
                      <option key={r} value={r}>
                        {ROLES[r].label}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              </DialogBody>
              <DialogFooter>
                <Button type="button" variant="secondary" disabled={invite.isPending} onClick={closeInvite}>
                  Cancel
                </Button>
                <Button type="submit" pending={invite.isPending} pendingLabel="Creating invite…">
                  Create invite
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
      {link && <InviteLink url={link} onClose={() => setLink(null)} />}
      {accountActions.rolesDialog}
    </div>
  );
}

function MemberMenu({
  member: u,
  busy,
  disabled,
  memberActions,
  accountMenu,
  canRoles,
  accountActions,
  onRole,
  onReactivate,
  onDeactivate,
  onLink,
  onCancelInvite,
}: {
  member: Me;
  busy: boolean;
  disabled: boolean;
  memberActions: boolean;
  accountMenu: boolean;
  canRoles: boolean;
  accountActions: AccountActions;
  onRole: (role: Role) => void;
  onReactivate: () => void;
  onDeactivate: () => void;
  onLink: () => void;
  onCancelInvite: () => void;
}) {
  const [open, setOpen] = useState(false);
  // The member's sign-in account, read when the menu first opens (one request, then cached).
  const account = useSiteAccount(u.accountId ?? null, accountMenu && open);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button variant="ghost" size="icon-sm" aria-label={busy ? `Working on ${u.name}…` : `Actions for ${u.name}`} aria-busy={busy || undefined}>
          {busy ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        {memberActions && (
          <>
            <DropdownMenuLabel>Team role</DropdownMenuLabel>
            {ASSIGNABLE.map((r) => (
              <DropdownMenuItem key={r} disabled={u.role === r} onSelect={() => onRole(r)}>
                {u.role === r ? <Check /> : <span className="size-4" aria-hidden />} {ROLES[r].label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            {u.invited && u.active && (
              <DropdownMenuItem onSelect={onLink}>
                <Link2 /> Copy invite link
              </DropdownMenuItem>
            )}
            {u.active ? (
              !u.invited && (
                <DropdownMenuItem destructive onSelect={onDeactivate}>
                  <UserMinus /> Deactivate…
                </DropdownMenuItem>
              )
            ) : (
              <DropdownMenuItem onSelect={onReactivate}>
                <RotateCcw /> {u.invited ? 'Switch the invite back on' : 'Reactivate'}
              </DropdownMenuItem>
            )}
            {u.invited && (
              <DropdownMenuItem destructive onSelect={onCancelInvite}>
                <X /> Cancel invite…
              </DropdownMenuItem>
            )}
          </>
        )}
        {accountMenu && (
          <>
            {memberActions && <DropdownMenuSeparator />}
            {account.data ? (
              <AccountMenuItems user={account.data} actions={accountActions} canRoles={canRoles} heading />
            ) : (
              <>
                <DropdownMenuLabel>Sign-in account</DropdownMenuLabel>
                {account.isError ? (
                  <DropdownMenuItem
                    onSelect={(e) => {
                      e.preventDefault();
                      void account.refetch();
                    }}
                  >
                    <RotateCcw /> Couldn’t load it. Try again
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem disabled>
                    <Loader2 className="animate-spin" /> Loading…
                  </DropdownMenuItem>
                )}
              </>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Customers ───

const STATUS_TABS: {value: 'all' | Exclude<StatusFilter, ''>; label: string}[] = [
  {value: 'all', label: 'All'},
  {value: 'active', label: 'Active'},
  {value: 'suspended', label: 'Blocked'},
];

/** DataTable keys rows by a string id; `userId` is the account's number. */
type TableRow = Omit<AdminUser, 'id'> & {id: string; userId: number};

/**
 * The site's accounts that are not on the team: support-portal customers. The site's admin API pages
 * every account (25 at a time, newest first); the team's own accounts are left out here (they are on
 * the Team tab). Listing needs site:user:read, actions site:user:update, roles site:role:read.
 * Addresses come from the server already masked for everyone but their owner and the site's owner.
 */
function CustomersTab() {
  const {abilities, viewerId, isOwner} = useSiteMe();
  const canUpdate = Boolean(abilities?.updateUsers);
  const canRoles = Boolean(abilities?.manageRoles);
  const team = useTeam();
  const actions = useAccountActions(viewerId);
  const [emailDraft, setEmailDraft] = useState('');
  const [filter, setFilter] = useState<{email: string; status: StatusFilter}>({email: '', status: ''});

  const users = useInfiniteQuery(siteUsersQuery(filter));
  // Role names for the badges; only people who may see roles can read them.
  const roles = useQuery({...siteRolesQuery, enabled: canRoles});
  const roleNames = new Map(roles.data?.roles.map((r) => [r.slug, r.name]));
  const members = new Set(team.data?.flatMap((m) => (m.accountId != null ? [m.accountId] : [])));

  const all = users.data?.pages.flatMap((p) => p.users);
  const rows: TableRow[] | undefined = team.data && all ? all.filter((u) => !members.has(u.id)).map((u) => ({...u, id: String(u.id), userId: u.id})) : undefined;
  // A page of only team accounts shows nothing here: read on until there is something (or no more).
  useEffect(() => {
    if (rows && rows.length === 0 && users.hasNextPage && !users.isFetchingNextPage && !users.isError) void users.fetchNextPage();
  }, [rows?.length, users.hasNextPage, users.isFetchingNextPage, users.isError]); // eslint-disable-line react-hooks/exhaustive-deps

  const asUser = (r: TableRow): AdminUser => ({...r, id: r.userId});
  const filtered = Boolean(filter.email || filter.status);
  const search = (e: FormEvent) => {
    e.preventDefault();
    setFilter((f) => ({...f, email: emailDraft.trim()}));
  };

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
              {!u.platformOwner && !u.emailVerified && <Badge tone="amber">Unconfirmed</Badge>}
            </div>
            <p className="truncate text-xs text-muted-foreground">{u.platformOwner ? 'Account owner' : u.email}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'roles',
      header: 'Site roles',
      hideBelow: 'md',
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
      cell: (u) => (u.platformOwner ? <span className="text-muted-foreground">Dashboard</span> : u.twoFactor ? <Badge tone="green">On</Badge> : <span className="text-muted-foreground">Off</span>),
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
        // The site owner's account comes from the dashboard: nothing to change here (the server refuses it too).
        if (u.platformOwner) return null;
        const busy = actions.busyId === u.id;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={actions.busyId !== null}>
              <Button variant="ghost" size="icon-sm" aria-label={busy ? `Working on ${u.name}…` : `Actions for ${u.name}`} aria-busy={busy || undefined}>
                {busy ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <AccountMenuItems user={u} actions={actions} canRoles={canRoles} />
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    });
  }

  const error = users.error ?? team.error;
  return (
    <>
      <SettingsSection
        title="Customers"
        description="Everyone else with an account on this site: your support-portal customers. Blocking someone signs them out and keeps them out until you unblock them."
      >
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {/* Looking people up by address is the site owner's alone (the server refuses anyone else). */}
          {isOwner ? (
            <form role="search" noValidate onSubmit={search} className="flex flex-wrap items-center gap-2">
              <Label htmlFor="customers-email" className="text-[13px]">
                Find by exact email
              </Label>
              <Input
                id="customers-email"
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
              <Button type="submit" variant="secondary" size="sm" pending={users.isFetching && !users.isFetchingNextPage && Boolean(filter.email)} pendingLabel="Finding…">
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

        {error && !rows?.length ? (
          <ErrorNote error={error} onRetry={() => void (users.error ? users.refetch() : team.refetch())} />
        ) : (
          <div className="-mx-5">
            <DataTable
              rows={rows}
              columns={columns}
              loading={!rows || (rows.length === 0 && users.hasNextPage)}
              empty={
                filtered ? (
                  <EmptyState
                    icon={<Search />}
                    title={filter.email ? 'No customer has that email' : 'No customers match'}
                    description={filter.email ? 'Check the spelling: the search needs the whole address. Team members are on the Team tab.' : 'Try another status.'}
                    action={
                      <Button variant="secondary" size="sm" onClick={() => (setEmailDraft(''), setFilter({email: '', status: ''}))}>
                        Show everyone
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState icon={<UserRound />} title="No customers yet" description="People show here once they create an account on the support portal." />
                )
              }
            />
          </div>
        )}
        {error && rows?.length ? (
          <div className="mt-4">
            <ErrorNote error={error} />
          </div>
        ) : null}
        <LoadMore hasNextPage={users.hasNextPage} isFetchingNextPage={users.isFetchingNextPage} fetchNextPage={users.fetchNextPage} />
      </SettingsSection>
      {actions.rolesDialog}
    </>
  );
}
