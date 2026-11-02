import {defineCollection} from 'astro:content';
import {glob} from 'astro/loaders';
import {z} from 'astro/zod';

/**
 * The blog: one Markdown file per post in `src/content/blog/`. The file name
 * is the URL (`hello-world.md` → `/blog/hello-world/`). Front matter is
 * checked at build time: a missing title or a bad date fails the build with
 * the file name, before anything goes live.
 */
const blog = defineCollection({
  loader: glob({pattern: '**/*.md', base: './src/content/blog'}),
  schema: ({image}) =>
    z.object({
      title: z.string().min(1).max(120),
      /** One or two sentences: the list, the meta description, social cards. */
      description: z.string().min(1).max(200),
      publishedAt: z.coerce.date(),
      updatedAt: z.coerce.date().optional(),
      author: z.string().max(80).optional(),
      /**
       * The cover (1200×630 or larger), one of:
       *   - a file in `src/assets/` relative to the post (`../../assets/blog/post.jpg`):
       *     optimised at BUILD (AVIF/WebP, several widths; `imageService: 'compile'`). PREFERRED;
       *   - a path in `public/` (`/images/post.webp`), served as committed;
       *   - an https URL (an image CDN).
       */
      cover: z
        .union([
          z.string().regex(/^(\/[^/]|https:\/\/)/, 'Use ./ or ../ for src/assets, a /path in public/ or an https:// URL.'),
          image(),
        ])
        .optional(),
      coverAlt: z.string().max(200).default(''),
      tags: z.array(z.string().max(40)).max(10).default([]),
      /** `true`: built in `npm run dev` only, never published. */
      draft: z.boolean().default(false),
    }),
});

export const collections = {blog};
