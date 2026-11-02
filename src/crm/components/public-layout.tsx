import type {ReactNode} from 'react';

import {useBrand} from '@/lib/use-brand';
import {cn} from '@/lib/utils';

import {Logo} from './logo';
import {ThemeToggle} from './theme-toggle';

/**
 * Frame for pages anyone can open without signing in (unsubscribe, and later
 * hosted forms, the support portal and booking pages). Server-rendered and
 * branded from Settings → Branding.
 */
export function PublicLayout({children}: {children: ReactNode}) {
  const brand = useBrand();
  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-background">
      <div className="blob -top-40 -left-32 size-[460px] bg-primary/15" />
      <div className="blob -right-40 -bottom-48 size-[480px] bg-secondary/15" />
      <header className="relative mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-5 sm:px-6">
        <Logo />
        <ThemeToggle />
      </header>
      <main className="relative mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 pb-12 sm:px-6">{children}</main>
      <footer className="relative py-6 text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} {brand.name}
      </footer>
    </div>
  );
}

/** Centered card most public pages use. */
export function PublicCard({children, className}: {children: ReactNode; className?: string}) {
  return <div className={cn('mx-auto mt-6 w-full max-w-lg rounded-2xl border border-slate-100 bg-card/95 p-6 shadow-soft backdrop-blur sm:mt-12 sm:p-8', className)}>{children}</div>;
}
