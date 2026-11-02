/**
 * The site's own words: navigation, home and about copy.
 *
 * Edit freely. The site's NAME and LOGO are not here: they come from the
 * platform (`GET /site-api/site`), so a rename in the dashboard shows
 * up without a Publish. Use `{name}` in any string below for the site name.
 */

/** Search and social basics. The NAME comes from the platform (above). */
export const SITE = {
  /** One sentence: the meta description of pages that have none of their own. Use `{name}`. */
  description: 'News, guides, open roles and your own dashboard at {name}.',
  /** `en`, `fr`, … : the page language (screen readers, search engines). */
  lang: 'en',
  /**
   * The address search engines should treat as THE address (canonical URLs,
   * sitemap, social cards): set it to the custom domain once the owner has one
   * (`https://www.example.com`, no trailing slash). Empty = the address
   * The platform gives the site (`SITE_URL`, src/lib/seo.ts).
   */
  url: '',
};

export interface NavItem {
  label: string;
  href: string;
  /**
   * `false` for a page rendered on every visit (SSR, like `/jobs/`): it is
   * private (`no-store`), so fetching it ahead would be wasted. Every other
   * item is prerendered and prefetched as soon as the nav is on screen.
   */
  prefetch?: false;
}

/**
 * Top navigation. Every href is a page of THIS site (`/`, `/blog/`, `/jobs/`,
 * `/about/`, `/dashboard`, `/account/…`): plain links.
 */
export const NAV: NavItem[] = [
  {label: 'Home', href: '/'},
  {label: 'Blog', href: '/blog/'},
  {label: 'Jobs', href: '/jobs/', prefetch: false},
  {label: 'About', href: '/about/'},
];

/**
 * The home page, top to bottom (`src/pages/index.astro`). Each block is one
 * section; reorder or drop freely. Rewrite every word for the business: what it
 * offers, who it is for, what a visitor does next. No invented reviews or numbers.
 */
export const HOME = {
  hero: {
    eyebrow: 'Welcome to {name}',
    /** The headline. `highlight` is the part of it shown with a marker behind it (or '' for none). */
    title: 'Everything you need, in one place',
    highlight: 'one place',
    body: 'Create your account in a minute, then keep your work, your files and your updates together in your own dashboard.',
    note: 'Sign up with your email. No setup needed.',
    /** Guests: create an account, or jump down the page. */
    guest: {primary: 'Create an account', secondary: 'See how it works'},
    /** Signed-in visitors. */
    user: {primary: 'Open your dashboard', secondary: 'Read the blog'},
  },
  /** The dashboard picture next to the headline: illustrative only, hidden from screen readers. */
  visual: {
    nav: ['Overview', 'Projects', 'Files', 'Messages', 'Settings'],
    title: 'Overview',
    stats: [
      {label: 'Open tasks', value: '12', trend: '+3 this week'},
      {label: 'Files', value: '48', trend: '+6 this week'},
      {label: 'Messages', value: '5', trend: '2 unread'},
    ],
    chart: 'Activity, last 30 days',
    rows: [
      {name: 'Welcome checklist', status: 'Done', tone: 'success'},
      {name: 'Monthly report', status: 'In progress', tone: 'info'},
      {name: 'Team photo', status: 'Waiting', tone: 'warning'},
    ],
  },
  features: {
    eyebrow: 'What you get',
    title: 'Built for the way you work',
    body: 'The essentials, ready from the first day, and nothing you have to learn first.',
    /** `icon`: one of the names in `src/components/home/Icon.astro`. */
    items: [
      {icon: 'user', title: 'Your own account', body: 'Sign up with your email and pick up where you left off, on any device.'},
      {icon: 'dashboard', title: 'A clear dashboard', body: 'Your work, your files and your latest updates together on one screen.'},
      {icon: 'bell', title: 'Updates that matter', body: 'Hear about what needs you, when it needs you, and nothing else.'},
      {icon: 'shield', title: 'Private and secure', body: 'Secure sign-in and a private space that only you can open.'},
      {icon: 'book', title: 'Practical guides', body: 'Stories and how-tos on the blog, written by the team.'},
      {icon: 'briefcase', title: 'Open roles', body: 'See who is hiring on the job board, updated as new roles open.'},
    ],
  },
  how: {
    eyebrow: 'How it works',
    title: 'Up and running in three steps',
    steps: [
      {title: 'Create your account', body: 'Enter your email and choose a password. It takes about a minute.'},
      {title: 'Make it yours', body: 'Add your details and choose what you want to see first.'},
      {title: 'Open your dashboard', body: 'Everything is there when you come back, on your phone or your computer.'},
    ],
  },
  blog: {title: 'Latest from the blog', link: 'All posts'},
  jobs: {title: 'Open roles', link: 'All jobs', remote: 'Remote'},
  faq: {
    eyebrow: 'Questions',
    title: 'Questions, answered',
    items: [
      {
        q: 'How do I create an account?',
        a: 'Choose Create an account at the top of any page, enter your email and pick a password. You can start right away.',
      },
      {
        q: 'Can I use it on my phone?',
        a: 'Yes. Every page works on phones, tablets and computers, and your dashboard is the same wherever you sign in.',
      },
      {
        q: 'Who can see my information?',
        a: 'Only you, once you are signed in. You can update your details from your dashboard at any time.',
      },
      {
        q: 'I forgot my password. What now?',
        a: 'Choose Sign in, then Forgot your password. We email you a link to set a new one.',
      },
    ],
  },
  cta: {
    title: 'Ready to get started with {name}?',
    body: 'Create your account in a minute and open your dashboard.',
    primary: 'Create an account',
    secondary: 'Sign in',
  },
};

export const ABOUT = {
  title: 'About {name}',
  lede: 'Who we are, and why we do this.',
  sections: [
    {
      heading: 'Our story',
      body: '{name} started with a simple idea: good things are easier together. Replace this text with your own story.',
    },
    {
      heading: 'What you will find here',
      body: 'A blog with practical guides, open roles, and a dashboard for everyone with an account.',
    },
    {
      heading: 'How to take part',
      body: 'Create an account and open your dashboard. Everyone is welcome.',
    },
  ],
};

/** Fill `{name}` with the site's name. */
export function withName(text: string, name: string): string {
  return text.replaceAll('{name}', name);
}
