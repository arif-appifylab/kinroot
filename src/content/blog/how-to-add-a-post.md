---
title: How to add a post
description: Add a Markdown file, fill in the front matter, publish.
publishedAt: 2026-10-10
author: The team
tags: [guide]
---

1. Create a file in `src/content/blog/`, for example `my-first-post.md` (lowercase, dashes).
2. Start it with the front matter: `title`, `description` and `publishedAt` are required;
   `author`, `cover`, `coverAlt`, `tags`, `updatedAt` and `draft` are optional.
3. For a cover, put the image in `src/assets/blog/` and point to it from the post
   (`cover: ../../assets/blog/my-first-post.jpg`): it is resized and converted for every
   screen when the site is built. Describe it in `coverAlt`, or leave that empty when the
   image is only decoration.
4. Write the post in Markdown below it.
5. Publish. The post, the blog list, the RSS feed, the sitemap and the home page update
   together.

Set `draft: true` to keep a post out of the live site while you work on it.
