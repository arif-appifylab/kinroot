import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {type FormEvent, useState} from 'react';

import type {AdminUser} from '../../lib/types';
import {api, read} from '../api';
import {rolesQuery, usersQuery} from '../queries';
import {ago, useMe, when} from '../shared';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  type Column,
  DataTable,
  Drawer,
  EmptyState,
  ErrorNote,
  LoadingBlock,
  LoadMore,
  Menu,
  type MenuItem,
  PageHeader,
  Person,
  SearchInput,
  SegmentedControl,
  StatusBadge,
  useConfirm,
  useToast,
} from '../ui';

type StatusFilter = '' | 'active' | 'suspended';

const STATUS_FILTERS: {value: StatusFilter; label: string}[] = [
  {value: '', label: 'All'},
  {value: 'active', label: 'Active'},
  {value: 'suspended', label: 'Suspended'},
];

/**
 * `/users` (site:user:read): every account, newest first, keyset-paged.
 * Find one by its exact email. Actions need site:user:update; the server
 * refuses anything that would act on someone with more access than you.
 */
export function Users() {
  const me = useMe();
  const abilities = me.data?.abilities;
  const viewerId = me.data?.viewer.id;
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [filter, setFilter] = useState<{email: string; status: StatusFilter}>({
    email: '',
    status: '',
  });
  const [editing, setEditing] = useState<AdminUser | null>(null);

  const users = useInfiniteQuery(usersQuery(filter));
  // Role names for the badges; only people who may see roles can read them.
  const roles = useQuery({...rolesQuery, enabled: Boolean(abilities?.manageRoles)});
  const roleNames = new Map(roles.data?.roles.map(role => [role.slug, role.name]));
  const refresh = () => queryClient.invalidateQueries({queryKey: ['users']});

  const setUserStatus = useMutation({
    mutationFn: ({id, status}: {id: number; status: 'active' | 'suspended'}) =>
      read(api.admin.users[':id'].$patch({param: {id: String(id)}, json: {status}})),
    onSuccess: refresh,
  });
  const endSessions = useMutation({
    mutationFn: (id: number) =>
      read(api.admin.users[':id'].sessions.revoke.$post({param: {id: String(id)}})),
  });
  // Lost phone and recovery codes: the user sets two-step sign-in up again on their next sign-in.
  const disableTwoFactor = useMutation({
    mutationFn: (id: number) =>
      read(api.admin.users[':id']['two-factor'].disable.$post({param: {id: String(id)}})),
    onSuccess: refresh,
  });
  const busyId =
    (setUserStatus.isPending && setUserStatus.variables?.id) ||
    (endSessions.isPending && endSessions.variables) ||
    (disableTwoFactor.isPending && disableTwoFactor.variables) ||
    null;
  const rows = users.data?.pages.flatMap(page => page.users);

  const search = (event: FormEvent) => {
    event.preventDefault();
    setFilter(current => ({...current, email: email.trim()}));
  };

  const askEndSessions = async (user: AdminUser) => {
    const done = await confirm({
      title: `Sign ${user.name} out everywhere?`,
      body: 'Every device they are signed in on is signed out. They can sign in again.',
      confirmLabel: 'End sessions',
      pendingLabel: 'Ending…',
      tone: 'primary',
      action: () => endSessions.mutateAsync(user.id),
    });
    if (done) toast.success(`${user.name} is signed out everywhere.`);
  };

  const askDisableTwoFactor = async (user: AdminUser) => {
    const done = await confirm({
      title: `Turn off two-step sign-in for ${user.name}?`,
      body: 'For someone who lost their phone and their recovery codes. They sign in with their password or an emailed code, then can set it up again.',
      confirmLabel: 'Turn it off',
      pendingLabel: 'Turning off…',
      tone: 'danger',
      action: () => disableTwoFactor.mutateAsync(user.id),
    });
    if (done) toast.success(`Two-step sign-in is off for ${user.name}.`);
  };

  const askStatus = async (user: AdminUser) => {
    const suspend = user.status === 'active';
    const done = await confirm(
      suspend
        ? {
            title: `Suspend ${user.name}?`,
            body: 'They are signed out at once and cannot sign in until you reactivate them.',
            confirmLabel: 'Suspend',
            pendingLabel: 'Suspending…',
            tone: 'danger',
            action: () => setUserStatus.mutateAsync({id: user.id, status: 'suspended'}),
          }
        : {
            title: `Reactivate ${user.name}?`,
            body: 'They can sign in again with their usual details.',
            confirmLabel: 'Reactivate',
            pendingLabel: 'Reactivating…',
            tone: 'primary',
            action: () => setUserStatus.mutateAsync({id: user.id, status: 'active'}),
          }
    );
    if (done)
      toast.success(
        suspend ? `${user.name} is suspended.` : `${user.name} can sign in again.`
      );
  };

  const columns: Column<AdminUser>[] = [
    {
      key: 'person',
      header: 'User',
      cell: user => (
        <span className="users-person">
          <Person name={user.name} detail={user.email} />
          {!user.emailVerified && <Badge tone="warning">Unconfirmed</Badge>}
        </span>
      ),
    },
    {
      key: 'roles',
      header: 'Roles',
      cell: user =>
        user.roles.length ? (
          <span className="badges">
            {user.roles.map(slug => (
              <Badge key={slug} tone={slug === 'owner' ? 'brand' : 'neutral'}>
                {roleNames.get(slug) ?? slug}
              </Badge>
            ))}
          </span>
        ) : (
          <span className="muted">None</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'shrink',
      cell: user =>
        user.status === 'suspended' ? (
          <StatusBadge tone="danger">Suspended</StatusBadge>
        ) : (
          <StatusBadge tone="success">Active</StatusBadge>
        ),
    },
    {
      key: 'last',
      header: 'Last sign-in',
      width: 'shrink',
      cell: user =>
        user.lastLoginAt ? (
          <time
            className="muted"
            dateTime={user.lastLoginAt}
            title={when(user.lastLoginAt)}>
            {ago(user.lastLoginAt)}
          </time>
        ) : (
          <span className="muted">Never</span>
        ),
    },
  ];

  if (abilities?.updateUsers) {
    columns.push({
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: user => {
        const self = user.id === viewerId;
        const items: MenuItem[] = [];
        if (abilities.manageRoles)
          items.push({
            label: 'Edit roles',
            icon: 'shield',
            onSelect: () => setEditing(user),
          });
        items.push({
          label: 'End sessions',
          icon: 'log-out',
          onSelect: () => void askEndSessions(user),
        });
        if (user.twoFactor && !self)
          items.push({
            label: 'Turn off two-step sign-in',
            icon: 'lock',
            onSelect: () => void askDisableTwoFactor(user),
          });
        if (!self) {
          items.push('separator');
          items.push(
            user.status === 'active'
              ? {
                  label: 'Suspend',
                  icon: 'ban',
                  danger: true,
                  onSelect: () => void askStatus(user),
                }
              : {
                  label: 'Reactivate',
                  icon: 'refresh',
                  onSelect: () => void askStatus(user),
                }
          );
        }
        return (
          <Menu
            label={`Actions for ${user.name}`}
            items={items}
            disabled={busyId === user.id}
          />
        );
      },
    });
  }

  const filtered = Boolean(filter.email || filter.status);

  return (
    <div className="app-page screen-users">
      <PageHeader title="Users" description="Everyone with an account on this site." />

      <div className="toolbar">
        <form className="users-search" role="search" onSubmit={search} noValidate>
          <SearchInput
            label="Find a user by their exact email"
            placeholder="Exact email, then Enter"
            value={email}
            maxLength={254}
            autoComplete="off"
            onChange={event => {
              setEmail(event.target.value);
              // The box's clear button: show everyone again.
              if (!event.target.value && filter.email)
                setFilter(current => ({...current, email: ''}));
            }}
          />
        </form>
        <SegmentedControl
          label="Status"
          options={STATUS_FILTERS}
          value={filter.status}
          onChange={status => setFilter(current => ({...current, status}))}
        />
      </div>

      <Card flush>
        <DataTable
          caption="Users"
          columns={columns}
          rows={rows}
          rowKey={user => user.id}
          loading={users.isPending}
          error={users.error}
          busyKey={busyId}
          empty={
            filtered ? (
              <EmptyState
                icon="search"
                title={filter.email ? 'No user has that email' : 'No users match'}
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setEmail('');
                      setFilter({email: '', status: ''});
                    }}>
                    Show everyone
                  </Button>
                }>
                {filter.email
                  ? 'Check the spelling: the search needs the whole address.'
                  : 'Try another status.'}
              </EmptyState>
            ) : (
              <EmptyState icon="users" title="No users yet">
                People show here once they sign up.
              </EmptyState>
            )
          }
        />
      </Card>
      {users.error && rows?.length ? <ErrorNote error={users.error} /> : null}
      <LoadMore query={users} />

      {editing && (
        <RoleEditor
          key={editing.id}
          user={editing}
          self={editing.id === viewerId}
          onClose={() => setEditing(null)}
          onSaved={() => {
            toast.success(`Roles saved for ${editing.name}.`);
            setEditing(null);
            void refresh();
            if (editing.id === viewerId)
              void queryClient.invalidateQueries({queryKey: ['me']});
          }}
        />
      )}
    </div>
  );
}

/** Pick a user's roles in a drawer. The server refuses roles you could not grant yourself. */
function RoleEditor({
  user,
  self,
  onClose,
  onSaved,
}: {
  user: AdminUser;
  self: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const roles = useQuery(rolesQuery);
  const [picked, setPicked] = useState<string[]>(user.roles);
  const save = useMutation({
    mutationFn: () =>
      read<{user: AdminUser}>(
        api.admin.users[':id'].roles.$put({
          param: {id: String(user.id)},
          json: {roles: picked},
        })
      ),
    onSuccess: onSaved,
  });
  const changed = picked.slice().sort().join() !== user.roles.slice().sort().join();

  return (
    <Drawer
      open
      onClose={onClose}
      dismissible={!save.isPending}
      title={`Roles for ${user.name}`}
      description={
        self
          ? 'These are your own roles. Removing one takes its access away from you.'
          : user.email
      }
      onSubmit={event => {
        event.preventDefault();
        if (changed) save.mutate();
      }}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            pending={save.isPending}
            pendingLabel="Saving…"
            disabled={!changed || roles.isPending}>
            Save roles
          </Button>
        </>
      }>
      <div className="form-stack">
        {roles.error && <ErrorNote error={roles.error} />}
        {roles.isPending ? (
          <LoadingBlock rows={3} />
        ) : (
          <fieldset className="checkbox-group">
            <legend>Roles</legend>
            {roles.data?.roles.map(role => (
              <Checkbox
                key={role.slug}
                label={role.name}
                description={role.description ?? undefined}
                checked={picked.includes(role.slug)}
                disabled={save.isPending}
                onChange={checked =>
                  setPicked(current =>
                    checked
                      ? [...current, role.slug]
                      : current.filter(slug => slug !== role.slug)
                  )
                }
              />
            ))}
          </fieldset>
        )}
        {save.error && <ErrorNote error={save.error} />}
      </div>
    </Drawer>
  );
}
