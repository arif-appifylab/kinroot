import {ArrowRight, CalendarDays, Handshake, LifeBuoy, ListChecks, Mail, MessageCircle, ShieldCheck} from 'lucide-react';

import type {PublicWebsite} from '@/lib/website';
import {useBrand} from '@/lib/use-brand';

import {openChat} from '../chat/chat-widget';
import {Button} from '../ui/button';
import {Card} from '../ui/card';
import {IconBadge} from '../ui/misc';

const HIGHLIGHT_ICONS = [<Handshake key="h" />, <ListChecks key="l" />, <ShieldCheck key="s" />];
const HIGHLIGHT_TONES = ['blue', 'teal', 'violet'] as const;

/** One way to get in touch, as a row in the hero card: a link, or a button (chat). */
function Way({href, onClick, icon, tone, title, text}: {href?: string; onClick?: () => void; icon: React.ReactNode; tone: 'blue' | 'teal' | 'violet' | 'amber'; title: string; text: string}) {
  const Tag = href ? 'a' : 'button';
  return (
    <Tag {...(href ? {href} : {type: 'button' as const, onClick})} className="group flex w-full cursor-pointer items-center gap-3 rounded-xl p-3 text-left transition-colors hover:bg-accent">
      <IconBadge tone={tone}>{icon}</IconBadge>
      <span className="min-w-0 flex-1">
        <span className="block font-bold text-slate-900">{title}</span>
        <span className="block truncate text-sm text-muted-foreground">{text}</span>
      </span>
      <ArrowRight className="size-4 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
    </Tag>
  );
}

/** Landing page at `/` for signed-out visitors. */
export function SiteHome({site}: {site: PublicWebsite}) {
  const brand = useBrand();
  const ways = [
    site.demo && <Way key="demo" href="/demo" icon={<CalendarDays />} tone="blue" title="Book a demo" text={`${site.demo.name} · ${site.demo.minutes} min`} />,
    site.chat && <Way key="chat" onClick={openChat} icon={<MessageCircle />} tone="violet" title="Chat with us" text="Talk to the team right now" />,
    site.contact && <Way key="contact" href="/contact" icon={<Mail />} tone="teal" title="Contact us" text="Send a message, we reply by email" />,
    site.support && <Way key="support" href="/support" icon={<LifeBuoy />} tone="amber" title="Get support" text="Already a customer? Open a request" />,
  ].filter(Boolean);

  return (
    <>
      <section className="grid grid-cols-1 items-center gap-10 pt-8 pb-16 sm:pt-14 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-14 lg:pt-20">
        <div className="min-w-0">
          <p className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-card/80 px-3 py-1 text-xs font-semibold text-slate-600 shadow-xs">
            <span className="size-1.5 rounded-full bg-success" aria-hidden /> {brand.name}
          </p>
          <h1 className="mt-5 text-4xl font-extrabold tracking-tight text-balance text-slate-900 sm:text-5xl lg:text-6xl">{site.headline}</h1>
          {site.subheadline && <p className="mt-5 max-w-xl text-lg leading-relaxed text-pretty text-slate-600">{site.subheadline}</p>}
          <div className="mt-8 flex flex-wrap gap-3">
            {site.demo && (
              <Button size="lg" asChild>
                <a href="/demo"><CalendarDays /> Book a demo</a>
              </Button>
            )}
            {site.contact && (
              <Button size="lg" variant="secondary" asChild>
                <a href="/contact"><Mail /> Contact us</a>
              </Button>
            )}
          </div>
          {site.chat && (
            <button type="button" onClick={openChat} className="mt-5 inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-primary hover:underline">
              <MessageCircle className="size-4" /> Prefer to chat? Start a conversation
            </button>
          )}
        </div>

        {ways.length > 0 && (
          <Card className="p-3 sm:p-4">
            <p className="px-3 pt-2 pb-1 text-xs font-bold tracking-wide text-slate-400 uppercase">Get in touch</p>
            <div className="grid gap-1">{ways}</div>
          </Card>
        )}
      </section>

      {site.highlights.length > 0 && (
        <section aria-labelledby="why" className="pb-16">
          <h2 id="why" className="sr-only">Why {brand.name}</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {site.highlights.map((h, i) => (
              <Card key={i} className="p-6">
                <IconBadge tone={HIGHLIGHT_TONES[i % 3]}>{HIGHLIGHT_ICONS[i % 3]}</IconBadge>
                <h3 className="mt-4 text-lg font-bold tracking-tight text-slate-900">{h.title}</h3>
                {h.text && <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{h.text}</p>}
              </Card>
            ))}
          </div>
        </section>
      )}

      {(site.demo || site.contact) && (
        <section className="relative overflow-hidden rounded-2xl bg-brand px-6 py-10 text-white shadow-lift sm:px-10">
          <div className="relative flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <h2 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Ready when you are</h2>
              <p className="mt-2 max-w-lg text-white/85">{site.demo ? 'Pick a time that works for you, it takes less than a minute.' : 'Tell us what you need and we will get back to you.'}</p>
            </div>
            <div className="flex flex-wrap gap-3">
              {site.demo && (
                <Button size="lg" variant="secondary" asChild className="border-transparent text-slate-900">
                  <a href="/demo">Book a demo</a>
                </Button>
              )}
              {site.contact && (
                <Button size="lg" variant="ghost" asChild className="text-white hover:bg-white/15 hover:text-white">
                  <a href="/contact">Contact us</a>
                </Button>
              )}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
