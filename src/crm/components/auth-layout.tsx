import {CheckCircle2, TrendingUp} from 'lucide-react';
import type {ReactNode} from 'react';

import {Logo} from './logo';
import {ThemeToggle} from './theme-toggle';

/**
 * Split auth screen: form on the left, an isometric "live pipeline" card on
 * the right floating over soft gradient orbs, the style's signature moment.
 */
export function AuthLayout({title, highlight, subtitle, children}: {title: string; highlight: string; subtitle: string; children: ReactNode}) {
  return (
    <div className="relative min-h-dvh overflow-hidden bg-background">
      <div className="blob -top-40 -left-32 size-[520px] bg-blue-300/40" />
      <div className="blob top-1/3 -right-40 size-[560px] bg-teal-200/50" />
      <div className="blob -bottom-48 left-1/3 size-[420px] bg-sky-200/50" />
      <ThemeToggle className="absolute top-4 right-4 z-10" />

      <div className="relative mx-auto grid grid-cols-1 min-h-dvh max-w-7xl items-center gap-12 px-4 py-10 sm:px-6 lg:grid-cols-2 lg:gap-20">
        <div className="mx-auto w-full max-w-md">
          <Logo />
          <h1 className="mt-10 text-3xl font-extrabold leading-[1.1] text-slate-900 sm:text-4xl">
            {title} <span className="text-brand">{highlight}</span>
          </h1>
          <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-muted-foreground">{subtitle}</p>
          <div className="mt-8 rounded-2xl border border-slate-100 bg-card/90 p-6 shadow-soft backdrop-blur sm:p-8">{children}</div>
        </div>

        <div className="hidden [perspective:2000px] lg:block" aria-hidden>
          <div className="transition-transform duration-500 ease-out [transform:rotateX(5deg)_rotateY(-12deg)] hover:[transform:rotateX(2deg)_rotateY(-8deg)]">
            <PreviewBoard />
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewBoard() {
  const cols = [
    {name: 'Qualified', color: '#38bdf8', deals: [['Northwind Labs', '$48k'], ['Kestrel Finance', '$18.5k']]},
    {name: 'Proposal', color: '#2563eb', deals: [['Orbit Retail', '$64k'], ['Fernway Health', '$12k']]},
    {name: 'Won', color: '#16a34a', deals: [['Sundial Studio', '$14k']]},
  ];
  return (
    <div className="relative">
      <div className="rounded-2xl border border-white/60 bg-card/80 p-5 shadow-lift backdrop-blur">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Pipeline</p>
            <p className="text-2xl font-extrabold text-slate-900">$284,500</p>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2.5 py-1 text-xs font-bold text-green-700">
            <TrendingUp className="size-3.5" /> +18% this month
          </span>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {cols.map((col) => (
            <div key={col.name} className="rounded-xl bg-slate-50 p-2.5">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-bold text-slate-600">
                <span className="size-2 rounded-full" style={{background: col.color}} />
                {col.name}
              </div>
              <div className="grid gap-2">
                {col.deals.map(([name, value]) => (
                  <div key={name} className="rounded-lg border border-slate-100 bg-card p-2.5 shadow-soft">
                    <p className="truncate text-[13px] font-semibold text-slate-800">{name}</p>
                    <p className="text-xs font-medium text-muted-foreground">{value}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="absolute -bottom-8 -left-10 flex animate-pulse items-center gap-3 rounded-xl border border-slate-100 bg-card px-4 py-3 shadow-lift [animation-duration:4s]">
        <CheckCircle2 className="size-5 text-green-600" />
        <div>
          <p className="text-sm font-semibold text-slate-800">Maya opened your proposal</p>
          <p className="text-xs text-muted-foreground">2 minutes ago</p>
        </div>
      </div>
    </div>
  );
}
