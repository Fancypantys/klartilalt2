import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";
import { SITE } from "@/config";

export const BLOG_PATH = "src/data/blog";

const blog = defineCollection({
  // Read all markdown files under src/data/blog (excluding underscored files/folders)
  loader: glob({ pattern: "**/[^_]*.md", base: `./${BLOG_PATH}` }),

  // Schema: relaxed + production-safe
  schema: ({ image }) =>
    z.object({
      // Core
      title: z.string(),
      description: z.string().default(""), // ensure required by theme
      draft: z.boolean().default(false),
      featured: z.boolean().default(false),

      // Dates (coerce string -> Date to play nice with Airtable/ISO strings)
      pubDatetime: z.coerce.date(),
      modDatetime: z.coerce.date().optional().nullable(),

      // Meta
      author: z.string().default(SITE.author),
      tags: z.array(z.string()).default(["others"]),
      ogImage: image().or(z.string()).optional(),
      canonicalURL: z.string().optional(),
      hideEditPost: z.boolean().optional(),
      timezone: z.string().optional(),

      // Optional slug if you include it in frontmatter; AstroPaper often derives from path
      slug: z.string().optional(),
      // Optional category (we route roundups by folder but keep field for convenience)
      category: z.string().optional(),
    }),
});

export const collections = { blog };
