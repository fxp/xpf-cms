import { z } from "zod";

export const STATES = ["idea","draft","review","approved","scheduled","published","updated","archived","removed"] as const;
export const VISIBILITY = ["private","internal","unlisted","public","gated"] as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const MetaV2 = z.object({
  slug: z.string().min(1),
  type: z.string().min(1).optional(),   // legacy v1 metas omit it → taken from the vertical directory
  topic_dir: z.string().optional(),
  title: z.record(z.string(), z.string().nullable()).refine(t => Object.keys(t).length > 0, "title needs at least one language"),
  status: z.enum(STATES).optional(),   // legacy v1 metas omit it → treated as published
  visibility: z.enum(VISIBILITY).optional(),
  summary: z.string().nullable().optional(),
  source: z.string().optional(),
  original_url: z.string().nullable().optional(),
  current_version: z.number().int().min(1).optional(),
  first_published: date.optional(),
  last_updated: date.optional(),
  publish_at: z.string().optional(),
  freshness_priority: z.enum(["hot","warm","cold"]).optional(),
  next_check: date.nullable().optional(),
  languages: z.array(z.string()).min(1).optional(),
  primary_language: z.string().optional(),
  translations: z.record(z.string(), z.any()).optional(),
  author: z.string().optional(),
  version_log: z.array(z.object({ v: z.number(), date: z.string(), git: z.string().optional(), summary: z.string() })).optional(),
  tags: z.array(z.string()).optional(),
  category: z.string().nullable().optional(),
  is_series: z.boolean().optional(),
  body_format: z.enum(["md","html","reveal","external","redirect"]).optional(),
  markdown_source: z.enum(["authored","derived","override"]).optional(),
  rotation: z.object({ asset: z.string(), validator: z.string(), ttl_days: z.number().optional(), rotated_at: date.optional(), expires_at: date.optional(), remind_before_days: z.number().optional(), history: z.array(z.any()).optional() }).optional(),
  links: z.object({ services: z.array(z.string()).optional(), entries: z.array(z.string()).optional() }).optional(),
}).passthrough();
export type Meta = z.infer<typeof MetaV2>;

/** Fields the legacy v1 schema marked required; missing ones are warnings, not errors. */
export const V1_REQUIRED = ["first_published","last_updated","languages","primary_language","tags","category","summary"] as const;
