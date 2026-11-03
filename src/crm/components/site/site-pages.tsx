import {CalendarCheck, CalendarDays, Clock, LifeBuoy, MessageCircle, Video} from 'lucide-react';

import {openChat} from '@/components/chat/chat-widget';
import {BookingWidget} from '@/components/booking/booking-widget';
import {CrmForm} from '@/components/forms/crm-form';
import {Card} from '@/components/ui/card';
import {IconBadge} from '@/components/ui/misc';
import type {PublicWebsite} from '@/lib/website';

import {SiteUnavailable} from './site-layout';

/** The website's /contact/ page: the contact form from Settings → Website and the other ways to reach the team. */
export function SiteContact({site}: {site: PublicWebsite}) {
  if (!site.enabled || !site.contact) return <SiteUnavailable title="Contact form unavailable" text="This page isn't set up yet. Please try again later." />;
  return (
    <div className="grid grid-cols-1 gap-8 pt-8 sm:pt-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] lg:gap-12">
      <div className="min-w-0">
        <h1 className="text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">Contact us</h1>
        <p className="mt-4 max-w-md text-lg leading-relaxed text-slate-600">Tell us a little about what you need. A real person reads every message and replies by email.</p>
        <ul className="mt-8 grid gap-4">
          <li className="flex items-start gap-3">
            <IconBadge tone="teal"><Clock /></IconBadge>
            <span className="min-w-0 pt-0.5"><span className="block font-bold text-slate-900">Usually within one business day</span><span className="block text-sm text-muted-foreground">You get a copy of your message straight away.</span></span>
          </li>
          {site.chat && (
            <li className="flex items-start gap-3">
              <IconBadge tone="violet"><MessageCircle /></IconBadge>
              <span className="min-w-0 pt-0.5"><span className="block font-bold text-slate-900">Need an answer now?</span><button type="button" onClick={openChat} className="block cursor-pointer text-sm font-semibold text-primary hover:underline">Chat with the team</button></span>
            </li>
          )}
          {site.demo && (
            <li className="flex items-start gap-3">
              <IconBadge tone="blue"><CalendarDays /></IconBadge>
              <span className="min-w-0 pt-0.5"><span className="block font-bold text-slate-900">Rather talk?</span><a href="/demo/" className="block text-sm font-semibold text-primary hover:underline">Book a {site.demo.minutes}-minute call</a></span>
            </li>
          )}
          {site.support && (
            <li className="flex items-start gap-3">
              <IconBadge tone="amber"><LifeBuoy /></IconBadge>
              <span className="min-w-0 pt-0.5"><span className="block font-bold text-slate-900">Already a customer?</span><a href="/support/" className="block text-sm font-semibold text-primary hover:underline">Open a support request</a></span>
            </li>
          )}
        </ul>
      </div>
      <Card className="p-6 sm:p-8">
        <CrmForm slug={site.contact.slug} />
      </Card>
    </div>
  );
}

/** The website's /demo/ page: the booking widget for the link picked in Settings → Website. */
export function SiteDemo({site}: {site: PublicWebsite}) {
  if (!site.enabled || !site.demo) return <SiteUnavailable title="Booking unavailable" text="Online booking isn't set up yet. Please try again later." />;
  // The booking widget shows the meeting itself (host, length, place) and needs the full width for its calendar.
  return (
    <div className="pt-8 sm:pt-12">
      <div className="max-w-2xl">
        <h1 className="text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">Book a demo</h1>
        <p className="mt-4 text-lg leading-relaxed text-slate-600">Pick a time that suits you. We will walk you through it and answer your questions.</p>
      </div>
      <Card className="mt-8 p-5 sm:p-7">
        <BookingWidget link={site.demo.path} />
      </Card>
      <ul className="mt-8 grid grid-cols-1 gap-5 md:grid-cols-3">
        <li className="flex items-start gap-3">
          <IconBadge tone="blue"><Clock /></IconBadge>
          <span className="min-w-0 pt-0.5"><span className="block font-bold text-slate-900">Your time zone</span><span className="block text-sm text-muted-foreground">Times are shown where you are; change it under the calendar.</span></span>
        </li>
        <li className="flex items-start gap-3">
          <IconBadge tone="teal"><Video /></IconBadge>
          <span className="min-w-0 pt-0.5"><span className="block font-bold text-slate-900">Everything by email</span><span className="block text-sm text-muted-foreground">The confirmation has the details and a calendar invite.</span></span>
        </li>
        <li className="flex items-start gap-3">
          <IconBadge tone="violet"><CalendarCheck /></IconBadge>
          <span className="min-w-0 pt-0.5"><span className="block font-bold text-slate-900">Easy to change</span><span className="block text-sm text-muted-foreground">{site.contact ? <>Reschedule from the email, or <a href="/contact/" className="font-semibold text-primary hover:underline">send us a message</a>.</> : 'Reschedule or cancel from the link in your email.'}</span></span>
        </li>
      </ul>
    </div>
  );
}
