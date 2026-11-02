import {useEffect} from 'react';

import type {PublicBookingLink} from '@/lib/scheduling';

import {PublicCard} from '../public-layout';
import {BookingWidget} from './booking-widget';

/* The link itself is loaded by the booking page's Astro host through the Site API (src/pages/book/). */

export const bookingHead = (link: PublicBookingLink | null | undefined, title: (t: string) => string) => ({
  meta: [
    {title: title(link ? `${link.name}${link.kind === 'personal' && link.hosts[0] ? ` with ${link.hosts[0].name}` : ''}` : 'Book a meeting')},
    ...(link?.description ? [{name: 'description', content: link.description.slice(0, 160)}] : []),
  ],
});

/** Embeds (?embed=1) follow the host page's theme (light unless ?theme=dark), not the visitor's saved one. */
export function useEmbedTheme(embed: boolean, theme?: 'light' | 'dark') {
  useEffect(() => {
    if (!embed) return;
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
  }, [embed, theme]);
}

export function BookingPage({path, link, embed, theme}: {path: string; link: PublicBookingLink | null; embed: boolean; theme?: 'light' | 'dark'}) {
  useEmbedTheme(embed, theme);
  if (!link) {
    const missing = (
      <div className="py-10 text-center">
        <h1 className="text-xl font-extrabold tracking-tight text-slate-900">Booking page not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">The link may be wrong, or this meeting type was removed.</p>
      </div>
    );
    return embed ? missing : <PublicCard>{missing}</PublicCard>;
  }
  if (embed) return <div className="p-3 sm:p-5"><BookingWidget link={path} initial={link} /></div>;
  return (
    <PublicCard className="max-w-4xl">
      <BookingWidget link={path} initial={link} />
    </PublicCard>
  );
}
