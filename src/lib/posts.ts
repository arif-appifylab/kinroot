import {type CollectionEntry, getCollection} from 'astro:content';

/** BUILD TIME helpers for the blog collection (`src/content.config.ts`). */

export type BlogPost = CollectionEntry<'blog'>;

/** Published posts, newest first. Drafts appear in `npm run dev` only. */
export async function publishedPosts(): Promise<BlogPost[]> {
  const posts = await getCollection('blog', post => import.meta.env.DEV || !post.data.draft);
  return posts.sort((a, b) => b.data.publishedAt.getTime() - a.data.publishedAt.getTime());
}

export const postHref = (post: BlogPost) => `/blog/${post.id}/`;

/** "9 September 2026", in UTC so the build machine's timezone never shifts it. */
export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'}).format(date);
}

/** About 230 words a minute, from the Markdown source. */
export function readingMinutes(markdown: string | undefined): number {
  const words = (markdown ?? '').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 230));
}
