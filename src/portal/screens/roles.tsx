import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useState} from 'react';

import {rules} from '../../lib/rules';
import type {PermissionRow, RoleRow} from '../../lib/types';
import {api, ApiError, read} from '../api';
import {permissionsQuery, rolesQuery} from '../queries';
import {useMe} from '../shared';
import {
  Badge,
  Icon,
  Button,
  Card,
  Checkbox,
  Drawer,
  EmptyState,
  ErrorNote,
  Field,
  LoadingBlock,
  Menu,
  Notice,
  PageHeader,
  useConfirm,
  useForm,
  useToast,
} from '../ui';

/** The role form's rules: the SAME limits `src/platform/auth/admin.ts` enforces. */
const ROLE_RULES = {
  slug: [
    rules.required('Enter a short id, like "editor".'),
    rules.pattern(
      /^[a-z][a-z0-9-]{1,47}$/,
      'Use 2 to 48 lowercase letters, digits or dashes, starting with a letter.'
    ),
  ],
  name: [rules.required('Enter a name.'), rules.maxLength(80)],
  description: [rules.maxLength(255)],
};

const OWNER = 'owner';

/**
 * `/roles` (site:role:read): what each role allows. Editing needs
 * site:role:update, and you can only grant permissions you hold yourself.
 * `owner` is fixed; built-in roles cannot be deleted.
 */
export function Roles() {
  const me = useMe();
  const canEdit = Boolean(me.data?.abilities.editRoles);
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [editing, setEditing] = useState<RoleRow | 'new' | null>(null);

  const roles = useQuery(rolesQuery);
  const catalogue = useQuery(permissionsQuery);
  const remove = useMutation({
    mutationFn: (slug: string) => read(api.admin.roles[':slug'].$delete({param: {slug}})),
    onSuccess: () => queryClient.invalidateQueries({queryKey: ['roles']}),
  });
  const titles = new Map(catalogue.data?.permissions.map(p => [p.codename, p.title]));

  const askDelete = async (role: RoleRow) => {
    const done = await confirm({
      title: `Delete the “${role.name}” role?`,
      body: 'People who have it lose what it allowed. This cannot be undone.',
      confirmLabel: 'Delete role',
      pendingLabel: 'Deleting…',
      action: () => remove.mutateAsync(role.slug),
    });
    if (done) toast.success(`The “${role.name}” role is deleted.`);
  };

  return (
    <div className="app-page screen-roles">
      <PageHeader
        title="Roles"
        description="A role is a set of permissions. Give roles to people on the Users screen."
        actions={
          canEdit && (
            <Button icon="plus" onClick={() => setEditing('new')}>
              New role
            </Button>
          )
        }
      />

      {roles.error ? (
        <ErrorNote error={roles.error} />
      ) : roles.isPending ? (
        <div className="grid-2">
          <Card>
            <LoadingBlock rows={2} />
          </Card>
          <Card>
            <LoadingBlock rows={2} />
          </Card>
        </div>
      ) : roles.data.roles.length === 0 ? (
        <Card>
          <EmptyState
            icon="shield"
            title="No roles yet"
            action={
              canEdit && <Button onClick={() => setEditing('new')}>New role</Button>
            }>
            A role groups permissions you can give to people.
          </EmptyState>
        </Card>
      ) : (
        <div className="grid-2">
          {roles.data.roles.map(role => {
            const fixed = role.slug === OWNER;
            const busy = remove.isPending && remove.variables === role.slug;
            return (
              <Card
                key={role.slug}
                className="roles-card"
                title={
                  <span className="roles-title">
                    {role.name}
                    {fixed ? (
                      <Badge tone="brand" icon="lock">
                        Fixed
                      </Badge>
                    ) : (
                      role.isSystem && <Badge>Built-in</Badge>
                    )}
                  </span>
                }
                description={<code>{role.slug}</code>}
                actions={
                  canEdit &&
                  !fixed && (
                    <Menu
                      label={`Actions for the ${role.name} role`}
                      disabled={busy}
                      items={[
                        {label: 'Edit', icon: 'pencil', onSelect: () => setEditing(role)},
                        ...(role.isSystem
                          ? []
                          : [
                              'separator' as const,
                              {
                                label: 'Delete',
                                icon: 'trash' as const,
                                danger: true,
                                onSelect: () => void askDelete(role),
                              },
                            ]),
                      ]}
                    />
                  )
                }>
                <div className="roles-body" aria-busy={busy || undefined}>
                  {role.description && (
                    <p className="roles-description">{role.description}</p>
                  )}
                  {role.members && (
                    <p className="roles-members">
                      <Icon name="users" size={14} />
                      {role.members.count === 0
                        ? 'Nobody has this role yet'
                        : `${role.members.count}${role.members.more ? '+' : ''} ${role.members.count === 1 && !role.members.more ? 'person' : 'people'}`}
                    </p>
                  )}
                  {fixed ? (
                    <p className="muted">
                      Everything, always. The owner role cannot be changed.
                    </p>
                  ) : role.permissions.length ? (
                    <span className="badges">
                      {role.permissions.map(codename => (
                        <span key={codename} title={codename}>
                          <Badge>{titles.get(codename) ?? codename}</Badge>
                        </span>
                      ))}
                    </span>
                  ) : (
                    <p className="muted">Signed in, nothing more.</p>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {editing !== null && (
        <RoleForm
          key={editing === 'new' ? 'new' : editing.slug}
          role={editing === 'new' ? null : editing}
          catalogue={catalogue.data?.permissions ?? []}
          catalogueError={catalogue.error}
          catalogueLoading={catalogue.isPending}
          onClose={() => setEditing(null)}
          onSaved={name => {
            toast.success(
              editing === 'new'
                ? `The “${name}” role is created.`
                : `The “${name}” role is saved.`
            );
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function RoleForm({
  role,
  catalogue,
  catalogueError,
  catalogueLoading,
  onClose,
  onSaved,
}: {
  role: RoleRow | null;
  catalogue: PermissionRow[];
  catalogueError: Error | null;
  catalogueLoading: boolean;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const queryClient = useQueryClient();
  const form = useForm(
    {
      slug: role?.slug ?? '',
      name: role?.name ?? '',
      description: role?.description ?? '',
    },
    role ? {name: ROLE_RULES.name, description: ROLE_RULES.description} : ROLE_RULES
  );
  const [picked, setPicked] = useState<string[]>(role?.permissions ?? []);
  const save = useMutation({
    mutationFn: (values: {slug: string; name: string; description: string}) =>
      role
        ? read(
            api.admin.roles[':slug'].$patch({
              param: {slug: role.slug},
              json: {
                name: values.name,
                description: values.description,
                permissions: picked,
              },
            })
          )
        : read(api.admin.roles.$post({json: {...values, permissions: picked}})),
    onSuccess: async (_data, values) => {
      await queryClient.invalidateQueries({queryKey: ['roles']});
      onSaved(values.name.trim());
    },
    onError: err => err instanceof ApiError && form.setServerErrors(err.fields),
  });
  const groups = [...new Set(catalogue.map(p => p.group))];
  const fieldErrors = save.error instanceof ApiError ? save.error.fields : {};
  const onField = ['slug', 'name', 'description'].some(name => fieldErrors[name]);

  return (
    <Drawer
      open
      onClose={onClose}
      dismissible={!save.isPending}
      title={role ? `Edit ${role.name}` : 'New role'}
      description="You can only give a role permissions you hold yourself."
      onSubmit={form.submit(values => save.mutate(values))}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" pending={save.isPending} pendingLabel="Saving…">
            {role ? 'Save changes' : 'Create role'}
          </Button>
        </>
      }>
      <div className="form-stack">
        {!role && (
          <Field
            id="f-slug"
            label="Id"
            hint="Lowercase, used in code, like “editor”. It cannot change later."
            error={form.error('slug')}>
            <input {...form.field('slug')} autoComplete="off" maxLength={48} />
          </Field>
        )}
        <Field id="f-name" label="Name" error={form.error('name')}>
          <input {...form.field('name')} autoComplete="off" maxLength={80} />
        </Field>
        <Field
          id="f-description"
          label="Description"
          optional
          error={form.error('description')}>
          <textarea {...form.field('description')} rows={2} maxLength={255} />
        </Field>

        {catalogueError && <ErrorNote error={catalogueError} />}
        {catalogueLoading ? (
          <LoadingBlock rows={3} />
        ) : (
          groups.map(group => (
            <fieldset className="checkbox-group" key={group}>
              <legend>{group}</legend>
              {catalogue
                .filter(p => p.group === group)
                .map(permission => (
                  <Checkbox
                    key={permission.codename}
                    label={permission.title}
                    description={permission.description ?? undefined}
                    checked={picked.includes(permission.codename)}
                    disabled={save.isPending}
                    onChange={checked =>
                      setPicked(current =>
                        checked
                          ? [...current, permission.codename]
                          : current.filter(codename => codename !== permission.codename)
                      )
                    }
                  />
                ))}
            </fieldset>
          ))
        )}
        {fieldErrors.permissions && (
          <Notice tone="danger">{fieldErrors.permissions}</Notice>
        )}
        {save.error && !onField && !fieldErrors.permissions && (
          <ErrorNote error={save.error} />
        )}
      </div>
    </Drawer>
  );
}
