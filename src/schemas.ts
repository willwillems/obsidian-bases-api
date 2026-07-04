import { z } from "@hono/zod-openapi";

// Frontmatter is arbitrary YAML → an open string-keyed record.
export const FrontmatterSchema = z
  .record(z.string(), z.unknown())
  .openapi("Frontmatter", {
    description: "Raw note frontmatter (arbitrary keys).",
  });

export const ErrorSchema = z
  .object({ error: z.string() })
  .openapi("Error", { example: { error: "not found" } });

export const BaseListSchema = z
  .object({
    bases: z.array(
      z.object({
        name: z.string().openapi({ example: "Posts" }),
        route: z.string().openapi({ example: "posts" }),
        notes: z.number().int().openapi({ example: 12 }),
      }),
    ),
  })
  .openapi("BaseList");

export const ListItemSchema = z
  .object({
    id: z.string().openapi({ example: "hello-world" }),
    title: z.string().openapi({ example: "Hello World" }),
    frontmatter: FrontmatterSchema,
    excerpt: z.string().openapi({
      description: "Plain-text excerpt of the body (~200 chars).",
    }),
  })
  .openapi("ListItem");

export const NoteListSchema = z
  .object({
    base: z.string().openapi({ example: "posts" }),
    total: z.number().int().openapi({ example: 12 }),
    limit: z.number().int().openapi({ example: 100 }),
    offset: z.number().int().openapi({ example: 0 }),
    items: z.array(ListItemSchema),
  })
  .openapi("NoteList");

export const NoteSchema = z
  .object({
    id: z.string().openapi({ example: "hello-world" }),
    title: z.string().openapi({ example: "Hello World" }),
    frontmatter: FrontmatterSchema,
    body: z.string().openapi({
      description: "Markdown body (frontmatter stripped).",
    }),
    assets: z
      .record(z.string(), z.string())
      .openapi({
        description: "Map of referenced asset filename → served URL.",
      }),
  })
  .openapi("Note");

export const HealthSchema = z
  .object({
    ok: z.boolean(),
    noteCount: z.number().int(),
    assetCount: z.number().int(),
    servedAssets: z.number().int(),
    lastSync: z.string().nullable().openapi({
      description: "ISO timestamp of last `ob sync`, or null.",
    }),
    builtAt: z.string().nullable().openapi({
      description: "ISO timestamp the index was last built, or null.",
    }),
    lastCheck: z.string().nullable().openapi({
      description:
        "ISO timestamp the vault was last fingerprinted for changes " +
        "(lastCheck > builtAt means rebuilds are being skipped), or null.",
    }),
    bases: z.array(
      z.object({
        route: z.string(),
        notes: z.number().int(),
        collisions: z.array(z.string()),
        filterErrors: z.array(z.string()).openapi({
          description:
            "Filter expressions that failed to parse; each evaluates as false.",
        }),
      }),
    ),
  })
  .openapi("Health");

export const CreateBodySchema = z
  .object({
    title: z.string().min(1).openapi({ example: "My New Note" }),
    body: z.string().optional().openapi({
      description: "Markdown body.",
      example: "Hello.",
    }),
    frontmatter: FrontmatterSchema.optional().openapi({
      description: "Extra frontmatter keys. `categories` is set automatically.",
    }),
  })
  .openapi("CreateNoteBody");

export const CreateResultSchema = z
  .object({
    created: z.string().openapi({ example: "My New Note.md" }),
    base: z.string().openapi({ example: "posts" }),
    id: z
      .string()
      .nullable()
      .openapi({ description: "GET slug if the note is public, else null." }),
  })
  .openapi("CreateNoteResult");
