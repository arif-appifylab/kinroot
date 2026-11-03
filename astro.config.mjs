import {fileURLToPath} from 'node:url';

import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import {tanstackRouter} from '@tanstack/router-plugin/vite';
import {defineConfig} from 'astro/config';

// Pages render on request on a Cloudflare Worker (the account pages are
// prerendered). Beside them the same Worker serves Kinroot, the CRM
// (`/crm/*`, a React app) and the Site API (`/site-api/*`, a Hono app).
// One project, one build, one dev server.
//
// Public pages stay real HTML pages (best for search), fetched ahead by
// `prefetch` (below) where a link asks for it. Kinroot is a React app with its own router.
//
// No wrangler config is committed: the platform writes the deploy config at
// build time, so it can never be broken by an edit here.
export default defineConfig({
  output: 'server',
  // Fetch a page before the click, for links marked `data-astro-prefetch`:
  // on hover or focus (`hover`), or as soon as it is on screen
  // (`data-astro-prefetch="viewport"`: phones have no hover).
  // OPT-IN, not `prefetchAll`: only links to PRERENDERED pages are marked.
  // Per-visit pages (`/crm/*`) answer `no-store`, so a prefetch of
  // them would be thrown away (a wasted Worker request), and Kinroot
  // preloads its own screens (TanStack Router). Skipped on slow connections
  // and with Data Saver. The script is a small deferred module from 'self'.
  prefetch: {prefetchAll: false, defaultStrategy: 'hover'},
  adapter: cloudflare({
    // Images in PRERENDERED pages (files in src/assets) are optimised at
    // BUILD time with sharp (AVIF/WebP, several widths); on the Worker they are
    // passed through, never resized: on-demand transforms need a Cloudflare
    // Images binding the platform does not give a Site.
    imageService: 'compile',
  }),
  vite: {
    plugins: [
      // Kinroot (src/crm): its screens are TanStack Router FILE routes in src/crm/routes; the
      // plugin writes src/crm/routeTree.gen.ts (git-ignored) and splits each screen's code.
      // It runs before React so the generated tree is there when the app is compiled.
      tanstackRouter({
        target: 'react',
        routesDirectory: './src/crm/routes',
        generatedRouteTree: './src/crm/routeTree.gen.ts',
        autoCodeSplitting: true,
        quoteStyle: 'single',
      }),
      // Kinroot's design system: Tailwind 4, compiled at build time from src/crm/styles.css.
      tailwindcss(),
    ],
    // Font files stay files: Vite would inline the small ones as data: URLs, which the CSP
    // (`font-src 'self'`) refuses.
    build: {assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined)},
    // `@/…` is Kinroot's own code (src/crm), as it was in the Kinroot app.
    resolve: {alias: {'@': fileURLToPath(new URL('./src/crm', import.meta.url))}},
  },
  integrations: [
    react(),
    {
      // `npm run build` while the Preview's dev server runs in the same folder
      // (the editor) must not rewrite the dev server's dependency cache under
      // it (every page then answered 500 until a restart): builds get their own.
      name: 'separate-build-cache',
      hooks: {
        'astro:config:setup': ({command, updateConfig}) => {
          if (command === 'build') updateConfig({vite: {cacheDir: 'node_modules/.vite-build'}});
        },
      },
    },
  ],
  // Sessions need a KV binding the platform does not give a Site either; with
  // them on, any `Astro.session` call would fail at request time. Sign-in is
  // the site's own (src/platform/auth), on cookies.
  session: false,
  redirects: {'/account': '/account/login/'},
  // No Markdown code blocks here; Shiki's inline styles would break the CSP.
  markdown: {syntaxHighlight: false},
  security: {
    // Astro writes a Content-Security-Policy into every page, with a hash for
    // each script and style it emits: no inline code it did not write runs.
    // `connect-src 'self'`: the browser only ever talks to this site's own
    // `/site-api` (file uploads too: their URL is a path on this site). Images, audio and
    // video may come from any https CDN (logos, stored files' signed links).
    // Frame protection is a header (`X-Frame-Options`, src/platform/headers.ts
    // and public/_headers): a meta CSP cannot set `frame-ancestors`.
    csp: {
      directives: [
        "default-src 'self'",
        "img-src 'self' https: data:",
        // Stored audio and video play from signed storage links (docs/agent/files.md).
        "media-src 'self' https: blob:",
        "font-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        // Sanitized HTML may embed these players (src/platform/sanitize.ts allows them).
        'frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com',
      ],
    },
  },
});
