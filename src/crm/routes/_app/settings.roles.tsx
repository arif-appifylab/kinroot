import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {createFileRoute} from '@tanstack/react-router';
import {Loader2, Lock, MoreHorizontal, Pencil, Plus, ShieldCheck, Trash2, Users} from 'lucide-react';
import {useState} from 'react';
import {toast} from 'sonner';

import {SettingsSection} from '@/components/settings-section';
import {ErrorNote, NoSiteAccess} from '@/components/site-admin/common';
import {RoleDialog} from '@/components/site-admin/role-dialog';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {confirm} from '@/components/ui/confirm';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger} from '@/components/ui/menu';
import {EmptyState, Skeleton} from '@/components/ui/misc';
import {pageTitle} from '@/lib/brand';
import {OWNER_ROLE, type RoleRow, siteApi, siteKeys, sitePermissionsQuery, siteRolesQuery, useSiteMe} from '@/lib/site-admin';

export const Route = createFileRoute('/_app/settings/roles')({
  head: () => ({meta: [{title: pageTitle('Roles')}]}),
  component: RolesSettings,
});

const DESCRIPTION = 'A site role is a set of permissions over the whole site (accounts, roles, the CRM). Give roles to people in Accounts. Ranks inside the CRM team are set in Team.';

/**
 * The site's roles and what each allows (`/site-api/admin/roles`, site:role:read), as the
 * template's Roles screen. Creating, editing and deleting need site:role:update, and you can only
 * give a role permissions you hold yourself. `owner` is fixed; built-in roles cannot be deleted.
 */
function RolesSettings() {
  const {loading, error, abilities, query: meQuery} = useSiteMe();
  if (loading) {
    return (
      <SettingsSection title="Roles">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{Array.from({length: 4}, (_, i) => <Skeleton key={i} className="h-28" />)}</div>
      </SettingsSection>
    );
  }
  if (error) {
    return (
      <SettingsSection title="Roles">
        <ErrorNote error={error} onRetry={() => void meQuery.refetch()} />
      </SettingsSection>
    );
  }
  if (!abilities?.manageRoles) {
    return (
      <SettingsSection title="Roles" description={DESCRIPTION}>
        <NoSiteAccess>Only the site’s owner and people whose site role lets them see roles can open this list.</NoSiteAccess>
      </SettingsSection>
    );
  }
  return <RolesList canEdit={abilities.editRoles} />;
}

function RolesList({canEdit}: {canEdit: boolean}) {
  const qc = useQueryClient();
  const roles = useQuery(siteRolesQuery);
  const catalogue = useQuery(sitePermissionsQuery);
  const [editing, setEditing] = useState<RoleRow | 'new' | null>(null);
  const titles = new Map(catalogue.data?.permissions.map((p) => [p.codename, p.title]));

  const remove = useMutation({
    mutationFn: (role: RoleRow) => siteApi.del(`/admin/roles/${encodeURIComponent(role.slug)}`),
    onSuccess: async (_r, role) => {
      await qc.invalidateQueries({queryKey: siteKeys.roles});
      toast.success(`The “${role.name}” role is deleted.`);
    },
    onError: (e) => toast.error(e.message),
  });
  const askDelete = async (role: RoleRow) => {
    const ok = await confirm({title: `Delete the “${role.name}” role?`, description: 'People who have it lose what it allowed. This cannot be undone.', confirmLabel: 'Delete role', destructive: true});
    if (ok) remove.mutate(role);
  };

  return (
    <>
      <SettingsSection
        title="Roles"
        description={DESCRIPTION}
        actions={
          canEdit && (
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus /> New role
            </Button>
          )
        }
      >
        {roles.error ? (
          <ErrorNote error={roles.error} onRetry={() => void roles.refetch()} />
        ) : roles.isPending ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{Array.from({length: 4}, (_, i) => <Skeleton key={i} className="h-28" />)}</div>
        ) : roles.data.roles.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck />}
            title="No roles yet"
            description="A role groups permissions you can give to people."
            action={canEdit && <Button size="sm" onClick={() => setEditing('new')}><Plus /> New role</Button>}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {roles.data.roles.map((role) => {
              const fixed = role.slug === OWNER_ROLE;
              const busy = remove.isPending && remove.variables?.slug === role.slug;
              return (
                <div key={role.slug} className="rounded-xl bg-slate-50 p-4" aria-busy={busy || undefined}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-slate-900">{role.name}</p>
                        {fixed ? (
                          <Badge tone="violet">
                            <Lock /> Fixed
                          </Badge>
                        ) : (
                          role.isSystem && <Badge tone="outline">Built-in</Badge>
                        )}
                      </div>
                      <code className="text-xs text-muted-foreground">{role.slug}</code>
                    </div>
                    {canEdit && !fixed && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild disabled={remove.isPending}>
                          <Button variant="ghost" size="icon-sm" aria-label={busy ? `Deleting ${role.name}…` : `Actions for the ${role.name} role`}>
                            {busy ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem onSelect={() => setEditing(role)}>
                            <Pencil /> Edit
                          </DropdownMenuItem>
                          {!role.isSystem && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem destructive onSelect={() => void askDelete(role)}>
                                <Trash2 /> Delete
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                  {role.description && <p className="mt-2 text-xs text-muted-foreground">{role.description}</p>}
                  {role.members && (
                    <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-slate-600">
                      <Users className="size-3.5" />
                      {role.members.count === 0 ? 'Nobody has this role yet' : `${role.members.count}${role.members.more ? '+' : ''} ${role.members.count === 1 && !role.members.more ? 'person' : 'people'}`}
                    </p>
                  )}
                  <div className="mt-3">
                    {fixed ? (
                      <p className="text-xs text-muted-foreground">Everything, always. The owner role cannot be changed.</p>
                    ) : role.permissions.length ? (
                      <span className="flex flex-wrap gap-1">
                        {role.permissions.map((codename) => (
                          <Badge key={codename} tone="outline" title={codename}>
                            {titles.get(codename) ?? codename}
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      <p className="text-xs text-muted-foreground">Signed in, nothing more.</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>

      {editing !== null && (
        <RoleDialog
          key={editing === 'new' ? 'new' : editing.slug}
          role={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(name) => {
            toast.success(editing === 'new' ? `The “${name}” role is created.` : `The “${name}” role is saved.`);
            setEditing(null);
            // Your own role may have changed what these screens show you.
            void qc.invalidateQueries({queryKey: siteKeys.me});
            void qc.invalidateQueries({queryKey: siteKeys.access});
          }}
        />
      )}
    </>
  );
}
