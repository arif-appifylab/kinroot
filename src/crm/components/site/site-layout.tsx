import {useQuery} from '@tanstack/react-query';
import {Menu} from 'lucide-react';
import type {ReactNode} from 'react';

import type {PublicWebsite} from '@/lib/website';
import {useBrand} from '@/lib/use-brand';
import {cn} from '@/lib/utils';
import {siteFetch} from '../../../platform/browser';

import {ChatWidget} from '../chat/chat-widget';
import {Logo} from '../logo';
import {ThemeToggle} from '../theme-toggle';
import {Button} from '../ui/button';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger} from '../ui/menu';

export type SitePage = 'home' | 'contact' | 'demo';

type NavItem = {key: SitePage | 'support'; label: string; to: string};

function navItems(site: PublicWebsite): NavItem[] {
  return [
    {key: 'home' as const, label: 'Home', to: '/'},
    site.demo && {key: 'demo' as const, label: 'Book a demo', to: '/demo/'},
    site.contact && {key: 'contact' as const, label: 'Contact us', to: '/contact/'},
    site.support && {key: 'support' as const, label: 'Support', to: '/support/'},
  ].filter((x): x is NavItem => !!x);
}

/**
 * Frame for the company's landing pages: branded header with the page links,
 * footer with the company address, and the chat bubble when chat is on.
 * Everything comes from Settings → Branding and Settings → Website.
 */
export function SiteLayout({site, page, children}: {site: PublicWebsite; page: SitePage; children: ReactNode}) {
  const brand = useBrand();
  // Checked in the browser: the pages are server-rendered without the session. Never sends anyone to
  // sign in (the CRM's `api` does on a 401): a visitor whose session ended just sees "Sign in".
  const signedIn = !!useQuery({
    queryKey: ['site', 'signed-in'],
    queryFn: async () => {
      const res = await siteFetch('/site-api/crm/auth/state');
      return res.ok ? !!((await res.json()) as {user?: unknown}).user : false;
    },
    retry: false,
    staleTime: 60_000,
  }).data;
  const account = signedIn ? {label: 'Open app', to: '/crm/'} : {label: 'Sign in', to: '/account/login/?next=%2Fcrm%2F'};
  const items = navItems(site);
  const cta = site.demo ? {label: 'Book a demo', to: '/demo/'} : site.contact ? {label: 'Contact us', to: '/contact/'} : null;
  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-background">
      <div className="blob -top-48 -left-40 size-[520px] bg-primary/15" />
      <div className="blob top-[420px] -right-48 size-[520px] bg-secondary/15" />

      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center gap-4 px-4 py-5 sm:px-6">
        <a href="/" aria-label={`${brand.name} home`} className="min-w-0 shrink-0">
          <Logo />
        </a>
        <nav aria-label="Main" className="ml-6 hidden items-center gap-1 lg:flex">
          {items.map((n) => (
            <a
              key={n.key}
              href={n.to}
              aria-current={n.key === page ? 'page' : undefined}
              className={cn('rounded-lg px-3 py-2 text-sm font-semibold whitespace-nowrap transition-colors', n.key === page ? 'text-slate-900' : 'text-slate-500 hover:bg-accent hover:text-slate-900')}
            >
              {n.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <Button variant="ghost" size="sm" asChild className="hidden sm:inline-flex">
            <a href={account.to}>{account.label}</a>
          </Button>
          {cta && page !== 'demo' && (
            <Button size="sm" asChild className="hidden sm:inline-flex">
              <a href={cta.to}>{cta.label}</a>
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="icon-sm" className="lg:hidden" aria-label="Menu"><Menu /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-52">
              {items.map((n) => (
                <DropdownMenuItem key={n.key} asChild>
                  <a href={n.to} aria-current={n.key === page ? 'page' : undefined}>{n.label}</a>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <a href={account.to}>{account.label}</a>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <main className="relative mx-auto w-full max-w-6xl flex-1 px-4 pb-16 sm:px-6">{children}</main>

      <footer className="relative border-t border-slate-100">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 text-sm sm:px-6 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <Logo />
            {site.address && <p className="mt-3 text-xs whitespace-pre-line text-muted-foreground">{site.address}</p>}
          </div>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2 text-slate-500">
            {items.map((n) => (
              <a key={n.key} href={n.to} className="hover:text-slate-900">{n.label}</a>
            ))}
          </nav>
        </div>
        <p className="pb-6 text-center text-xs text-muted-foreground">© {new Date().getFullYear()} {brand.name}</p>
      </footer>

      {site.chat && <ChatWidget />}
    </div>
  );
}

/** Shown on a landing page when Settings → Website is off (or the page has nothing to show). */
export function SiteUnavailable({title, text}: {title: string; text: string}) {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-2xl border border-slate-100 bg-card/95 p-8 text-center shadow-soft">
      <h1 className="text-xl font-extrabold tracking-tight text-slate-900">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{text}</p>
      <Button variant="secondary" className="mt-5" asChild>
        <a href="/">Back to the home page</a>
      </Button>
    </div>
  );
}
