import type {QueryClient} from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  type ErrorComponentProps,
  Link,
  lazyRouteComponent,
  Outlet,
  useMatches,
  useNavigate,
  useRouter,
  useRouterState,
} from '@tanstack/react-router';
import {useEffect, useRef, useState} from 'react';

import type {Abilities} from '../lib/types';
import {logout} from '../platform/browser';
import {
  auditQuery,
  firstAuditQuery,
  firstJobsQuery,
  firstUsersQuery,
  healthQuery,
  manageJobsQuery,
  meQuery,
  permissionsQuery,
  rolesQuery,
  sessionsQuery,
  siteQuery,
  twoFactorQuery,
  usersQuery,
} from './queries';
import {useMe, useSite} from './shared';
import {
  Avatar,
  Button,
  buttonClass,
  ConfirmProvider,
  EmptyState,
  Icon,
  IconButton,
  type IconName,
  initials,
  LoadingBlock,
  Menu,
  ToastProvider,
} from './ui';

/**
 * The portal's screens: a TanStack Router app under `/dashboard` (basepath),
 * served by `src/pages/portal/[...path].astro` (signed-in users only), with
 * data from the Site API through TanStack Query. Links INSIDE the portal use
 * `<Link>`; links to the website (`/`, `/blog/`, `/account/…`) are plain
 * `<a href>`.
 *
 * Add a screen (all five, every time):
 *   1. its reads as `queryOptions` in `queries.ts`, used by the screen with `useQuery(x)`;
 *   2. the component in `screens/<name>.tsx` (a named export);
 *   3. a `createRoute` below: literal `path`, `staticData.title` (the top bar
 *      and the tab), a `loader` that warms its queries, and the component
 *      LAZY (`lazyRouteComponent(() => import('./screens/<name>'), 'Name')`)
 *      so its code loads on first use (or on hover), never in the first bundle;
 *   4. its route in `routeTree`;
 *   5. one item in `NAV_GROUPS` if it belongs in the sidebar.
 * Never a plain `<a href>` to a portal path: it reloads the whole app.
 */

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** The screen's name: the top bar's `<h1>` and the tab's title. */
    title?: string;
  }
}

/**
 * Warm a screen's queries before it renders (on navigation, and on hover via
 * `defaultPreload: 'intent'`). A failed read is NOT thrown: the screen shows
 * the error in place from the same query, as it always has.
 */
const warm = (...reads: Promise<unknown>[]) => Promise.all(reads.map(read => read.catch(() => undefined))).then(() => undefined);

/** While a slow screen loads (after `defaultPendingMs`). */
export function RoutePending() {
  return (
    <div className="app-page">
      <LoadingBlock rows={4} />
    </div>
  );
}

/** A screen that failed to render or to load its code (an old tab after a Publish: reload). */
export function RouteError({error}: ErrorComponentProps) {
  const router = useRouter();
  const failure = error instanceof Error ? error : new Error('Something went wrong.');
  const stale = /dynamically imported module|module script|Importing a module/i.test(failure.message);
  return (
    <div className="app-page">
      <EmptyState
        icon={stale ? 'refresh' : 'alert'}
        title={stale ? 'This dashboard was updated' : 'This screen could not load'}
        action={
          <Button variant="secondary" icon="refresh" onClick={() => (stale ? window.location.reload() : void router.invalidate())}>
            {stale ? 'Reload' : 'Try again'}
          </Button>
        }>
        {stale ? 'Reload to get the new version.' : failure.message}
      </EmptyState>
    </div>
  );
}

type NavItem = {to: string; label: string; icon: IconName; exact?: boolean; ability?: keyof Abilities};

/**
 * The sidebar, in groups. `ability` hides an item the visitor may not use;
 * that only HIDES it, the route's guard is the enforcement. A group with no
 * visible item is not shown.
 */
const NAV_GROUPS: {label: string; items: NavItem[]}[] = [
  {
    label: 'Workspace',
    items: [
      {to: '/', label: 'Overview', icon: 'dashboard', exact: true},
      {to: '/account', label: 'Your account', icon: 'user'},
    ],
  },
  {
    label: 'Manage',
    items: [
      {to: '/jobs', label: 'Jobs', icon: 'briefcase', ability: 'manageJobs'},
      {to: '/users', label: 'Users', icon: 'users', ability: 'manageUsers'},
      {to: '/roles', label: 'Roles', icon: 'shield', ability: 'manageRoles'},
      {to: '/activity', label: 'Activity', icon: 'activity', ability: 'readAudit'},
    ],
  },
  // Only in the Preview and `npm run dev` (never in a build): the UI kit, on screen.
  ...(import.meta.env.DEV
    ? [{label: 'Build', items: [{to: '/components', label: 'Components', icon: 'layers' as const}]}]
    : []),
];

/** The screen's title for the top bar and the tab: the deepest route's `staticData.title`. */
function useScreenTitle() {
  const matches = useMatches();
  return [...matches].reverse().find(match => match.staticData.title)?.staticData.title ?? 'Dashboard';
}

/**
 * After every in-app navigation (never the first load): the tab title says
 * where you are, and focus moves to the screen's `<h1>` so keyboard and
 * screen reader users start at the new screen (it is read out), as after a
 * page load.
 */
function useNavigationFocus(title: string, siteName: string | undefined) {
  const heading = useRef<HTMLHeadingElement>(null);
  const resolved = useRouterState({select: s => s.resolvedLocation?.pathname});
  const first = useRef(true);
  // "<title> · <site>", as App.astro writes it on the first load.
  const [fallbackName] = useState(() => document.title.split(' · ').slice(1).join(' · ') || 'My site');
  useEffect(() => {
    document.title = `${title} · ${siteName ?? fallbackName}`;
  }, [title, siteName, fallbackName]);
  useEffect(() => {
    if (!resolved) return;
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus({preventScroll: true});
  }, [resolved]);
  return {heading, resolved};
}

type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'site:theme';

/** Light, dark or the device's: `data-theme` on <html> (global.css), remembered in this browser. */
function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      return saved === 'light' || saved === 'dark' ? saved : 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Storage blocked: the choice lasts until the tab closes.
    }
  }, [theme]);
  return [theme, setTheme] as const;
}

/**
 * The app shell: a full-height sidebar (brand, grouped nav, way back to the
 * website), a top bar (screen title, theme, the user's menu) and the screen
 * in between; a drawer with a scrim on small screens. Every screen renders
 * inside it, with toasts (`useToast`) and confirmations (`useConfirm`)
 * mounted once here. Nothing here reloads the page.
 */
const rootRoute = createRootRouteWithContext<{queryClient: QueryClient}>()({
  component: function Root() {
    return (
      <ToastProvider>
        <ConfirmProvider>
          <Shell />
        </ConfirmProvider>
      </ToastProvider>
    );
  },
  notFoundComponent: () => (
    <div className="app-page">
      <EmptyState
        icon="search"
        title="This page does not exist"
        action={
          <Link className={buttonClass({variant: 'secondary'})} to="/">
            Back to the overview
          </Link>
        }>
        The link may be old, or the page was moved.
      </EmptyState>
    </div>
  ),
});

function Shell() {
  const me = useMe();
  const site = useSite();
  const navigate = useNavigate();
  const title = useScreenTitle();
  const siteName = site.data?.site?.name;
  const {heading, resolved} = useNavigationFocus(title, siteName);
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  // `logout()` reloads the page when it is done, so pending never needs resetting.
  const [signingOut, setSigningOut] = useState(false);
  const viewer = me.data?.viewer;
  const abilities = me.data?.abilities;
  // Signed out meanwhile (or never signed in, in the editor Preview, where
  // the host page cannot see the session): go and sign in, then come back.
  const signedOut = viewer !== undefined && viewer.state !== 'user';
  useEffect(() => {
    if (!signedOut) return;
    const back = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
    window.location.replace(`/account/login/?next=${back}`);
  }, [signedOut]);
  // The drawer closes on navigation and on Esc.
  useEffect(() => setOpen(false), [resolved]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  if (signedOut) return null;

  const name = siteName ?? 'My site';
  const logo = site.data?.site?.logo;
  return (
    <div className="app-shell" data-nav-open={open ? '' : undefined}>
      <aside className="app-sidebar" aria-label="Sidebar">
        <a className="app-brand" href="/">
          <span className="app-brand-mark">{logo ? <img src={logo} alt="" /> : initials(name) || '·'}</span>
          <span className="app-brand-name">{name}</span>
        </a>
        <nav className="app-nav" aria-label="Dashboard">
          {NAV_GROUPS.map(group => {
            const items = group.items.filter(item => !item.ability || abilities?.[item.ability]);
            if (!items.length) return null;
            return (
              <div className="app-nav-group" key={group.label}>
                <p className="app-nav-label">{group.label}</p>
                {items.map(item => (
                  <Link key={item.to} to={item.to} className="app-nav-link" activeOptions={{exact: item.exact ?? false}}>
                    <Icon name={item.icon} size={18} />
                    {item.label}
                  </Link>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="app-sidebar-foot">
          <a className="app-nav-link" href="/">
            <Icon name="arrow-left" size={18} />
            Back to the website
          </a>
        </div>
      </aside>
      <button type="button" className="app-scrim" aria-label="Close the menu" tabIndex={-1} onClick={() => setOpen(false)} />

      <div className="app-main">
        <header className="app-topbar">
          <IconButton
            className="app-menu-button"
            icon={open ? 'x' : 'menu'}
            label={open ? 'Close the menu' : 'Open the menu'}
            aria-expanded={open}
            onClick={() => setOpen(value => !value)}
          />
          <h1 className="app-title" ref={heading} tabIndex={-1}>
            {title}
          </h1>
          <div className="app-topbar-actions">
            <Menu
              label={`Theme: ${theme}`}
              trigger={<Icon name={theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'monitor'} size={18} />}
              items={[
                {label: 'Light', icon: 'sun', onSelect: () => setTheme('light')},
                {label: 'Dark', icon: 'moon', onSelect: () => setTheme('dark')},
                {label: 'Same as this device', icon: 'monitor', onSelect: () => setTheme('system')},
              ]}
            />
            {viewer && (
              <Menu
                label={`Account menu for ${viewer.name ?? 'you'}`}
                trigger={
                  <>
                    {signingOut ? <span className="spinner" aria-hidden="true" /> : <Avatar name={viewer.name ?? ''} size="sm" />}
                    <span className="app-viewer-name">{signingOut ? 'Signing out…' : viewer.name}</span>
                    <Icon name="chevron-down" size={16} />
                  </>
                }
                disabled={signingOut}
                items={[
                  {label: 'Your account', icon: 'user', onSelect: () => void navigate({to: '/account'})},
                  {label: 'Back to the website', icon: 'globe', onSelect: () => window.location.assign('/')},
                  'separator',
                  {
                    label: 'Sign out',
                    icon: 'log-out',
                    onSelect: () => {
                      setSigningOut(true);
                      void logout();
                    },
                  },
                ]}
              />
            )}
          </div>
        </header>
        <main className="app-content" id="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

// One `createRoute` per screen, with a LITERAL path (`<Link to>` is typed from
// them), a title, a loader over the screen's own queryOptions, a lazy screen.
const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  staticData: {title: 'Overview'},
  loader: async ({context: {queryClient}}) => {
    // The tiles the visitor may see, as the screen's `enabled` flags decide.
    const [me] = await Promise.all([queryClient.ensureQueryData(meQuery).catch(() => null), warm(queryClient.ensureQueryData(healthQuery), queryClient.ensureQueryData(twoFactorQuery), queryClient.ensureQueryData(siteQuery))]);
    const can = me?.abilities;
    await warm(
      ...(can?.manageUsers ? [queryClient.ensureQueryData(firstUsersQuery)] : []),
      ...(can?.manageJobs ? [queryClient.ensureQueryData(firstJobsQuery)] : []),
      ...(can?.readAudit ? [queryClient.ensureQueryData(firstAuditQuery)] : [])
    );
  },
  component: lazyRouteComponent(() => import('./screens/overview'), 'Overview'),
});
const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account',
  staticData: {title: 'Your account'},
  // `?tab=security`: a link can open one section of the account screen.
  validateSearch: (search: Record<string, unknown>): {tab?: string} =>
    typeof search.tab === 'string' ? {tab: search.tab} : {},
  loader: ({context: {queryClient}}) =>
    warm(
      queryClient.ensureQueryData(meQuery),
      queryClient.ensureQueryData(twoFactorQuery),
      queryClient.ensureQueryData(sessionsQuery)
    ),
  component: lazyRouteComponent(() => import('./screens/account'), 'Account'),
});
const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/jobs',
  staticData: {title: 'Jobs'},
  loader: ({context: {queryClient}}) => warm(queryClient.ensureInfiniteQueryData(manageJobsQuery)),
  component: lazyRouteComponent(() => import('./screens/jobs'), 'Jobs'),
});
const usersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/users',
  staticData: {title: 'Users'},
  loader: ({context: {queryClient}}) => warm(queryClient.ensureInfiniteQueryData(usersQuery({email: '', status: ''}))),
  component: lazyRouteComponent(() => import('./screens/users'), 'Users'),
});
const rolesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/roles',
  staticData: {title: 'Roles'},
  loader: ({context: {queryClient}}) =>
    warm(queryClient.ensureQueryData(rolesQuery), queryClient.ensureQueryData(permissionsQuery)),
  component: lazyRouteComponent(() => import('./screens/roles'), 'Roles'),
});
const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/activity',
  staticData: {title: 'Activity'},
  loader: ({context: {queryClient}}) => warm(queryClient.ensureInfiniteQueryData(auditQuery)),
  component: lazyRouteComponent(() => import('./screens/activity'), 'Activity'),
});

// The UI kit on screen, for the owner and their agent. Dev only: the whole route (and its
// chunk) is left out of a build, because `import.meta.env.DEV` is `false` there.
const devRoutes = import.meta.env.DEV
  ? [
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/components',
        staticData: {title: 'Components'},
        component: lazyRouteComponent(() => import('./screens/components'), 'Components'),
      }),
    ]
  : [];

export const routeTree = rootRoute.addChildren([
  overviewRoute,
  accountRoute,
  jobsRoute,
  usersRoute,
  rolesRoute,
  activityRoute,
  ...devRoutes,
]);
