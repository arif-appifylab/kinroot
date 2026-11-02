import {BookingPage} from '@/components/booking/booking-page';
import type {Brand} from '@/lib/brand';
import type {PublicBookingLink} from '@/lib/scheduling';

import {PublicPage} from './public-page';

/** A booking page, /book/<handle>/<slug> or /book/team/<slug> (src/pages/book/[handle]/[slug].astro). */
export default function BookingLinkPage({brand, path, link}: {brand: Brand; path: string; link: PublicBookingLink | null}) {
  return (
    <PublicPage brand={brand}>
      <BookingPage path={path} link={link} embed={false} />
    </PublicPage>
  );
}
