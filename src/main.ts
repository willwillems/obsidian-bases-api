import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { serveFile } from "@std/http/file-server";
import { stringify } from "@std/yaml";
import { API_KEY, PORT, VAULT } from "./config.ts";
import { checkBearer } from "./auth.ts";
import { getIndex, getState, refreshNow, warmup } from "./runtime.ts";
import { type Note, referencedAssets, type VaultIndex } from "./indexer.ts";
import {
  BaseListSchema,
  CreateBodySchema,
  CreateResultSchema,
  ErrorSchema,
  HealthSchema,
  ListItemSchema,
  NoteListSchema,
  NoteSchema,
} from "./schemas.ts";

const app = new OpenAPIHono();

// ---- helpers ------------------------------------------------------------

const titleOf = (n: Note): string =>
  typeof n.frontmatter.title === "string" && n.frontmatter.title.trim()
    ? (n.frontmatter.title as string)
    : n.name;

function excerpt(body: string, len = 200): string {
  const t = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[\[[^\]]*\]\]/g, " ")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > len ? t.slice(0, len).trimEnd() + "…" : t;
}

function assetMap(index: VaultIndex, note: Note): Record<string, string> {
  const map: Record<string, string> = {};
  for (const ref of referencedAssets(note.body, note.frontmatter)) {
    if (index.allowedAssets.has(ref.toLowerCase())) {
      map[ref] = `/api/assets/${encodeURIComponent(ref)}`;
    }
  }
  return map;
}

const listItem = (slug: string, n: Note): z.infer<typeof ListItemSchema> => ({
  id: slug,
  title: titleOf(n),
  frontmatter: n.frontmatter,
  excerpt: excerpt(n.body),
});

const jsonContent = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});

// ---- OpenAPI wiring -----------------------------------------------------

app.openAPIRegistry.registerComponent("securitySchemes", "Bearer", {
  type: "http",
  scheme: "bearer",
});

// ---- static / meta routes (registered before param routes) --------------

app.get(
  "/",
  (c) =>
    c.json({
      name: "obsidian-bases-api",
      docs: "/api",
      openapi: "/api/openapi.json",
    }),
);

// The generated spec. Registered before the `/api/{base}` param route so the
// literal `/api/openapi.json` path isn't captured as a base name.
app.doc31("/api/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "obsidian-bases-api",
    version: "1.0.0",
    description:
      "Read-mostly HTTP API over an Obsidian vault, derived from its Bases. " +
      "GET is public; POST requires a bearer token.",
  },
  servers: [{ url: "/" }],
});

const listBasesRoute = createRoute({
  method: "get",
  path: "/api",
  summary: "List bases",
  responses: { 200: jsonContent(BaseListSchema, "The available bases.") },
});
app.openapi(listBasesRoute, async (c) => {
  const index = await getIndex();
  return c.json(
    {
      bases: index.bases.map((b) => ({
        name: b.name,
        route: b.route,
        notes: index.baseData.get(b.route)?.items.length ?? 0,
      })),
    },
    200,
  );
});

const healthRoute = createRoute({
  method: "get",
  path: "/api/_health",
  summary: "Health & index stats",
  responses: { 200: jsonContent(HealthSchema, "Index counts and sync state.") },
});
app.openapi(healthRoute, async (c) => {
  const index = await getIndex();
  const { lastSync, builtAt, lastCheck } = getState();
  return c.json(
    {
      ok: true,
      noteCount: index.notes.length,
      assetCount: index.assetsByName.size,
      servedAssets: index.allowedAssets.size,
      lastSync: lastSync ? new Date(lastSync).toISOString() : null,
      builtAt: builtAt ? new Date(builtAt).toISOString() : null,
      lastCheck: lastCheck ? new Date(lastCheck).toISOString() : null,
      bases: index.bases.map((b) => {
        const bd = index.baseData.get(b.route)!;
        return {
          route: b.route,
          notes: bd.items.length,
          collisions: bd.collisions,
          filterErrors: b.filterErrors,
        };
      }),
    },
    200,
  );
});

// Binary response — documented via the registry, served by a plain handler.
app.openAPIRegistry.registerPath({
  method: "get",
  path: "/api/assets/{name}",
  summary: "Fetch an asset",
  description: "Returns an asset file, only if referenced by a reachable note.",
  request: { params: z.object({ name: z.string() }) },
  responses: {
    200: {
      description: "The asset bytes.",
      content: {
        "application/octet-stream": {
          schema: { type: "string", format: "binary" },
        },
      },
    },
    404: jsonContent(ErrorSchema, "Asset not found or not served."),
  },
});
app.get("/api/assets/:name", async (c) => {
  // Hono has already percent-decoded the param — no second decode.
  const name = c.req.param("name").toLowerCase();
  const index = await getIndex();
  if (!index.allowedAssets.has(name)) {
    return c.json({ error: "not found" }, 404);
  }
  const abs = index.assetsByName.get(name);
  if (!abs) return c.json({ error: "not found" }, 404);
  const res = await serveFile(c.req.raw, abs);
  // Assets are user-uploaded bytes (SVG/HTML possible): never execute on this origin.
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Content-Security-Policy", "sandbox");
  return res;
});

// ---- base collection + item ---------------------------------------------

const listNotesRoute = createRoute({
  method: "get",
  path: "/api/{base}",
  summary: "List reachable notes in a base",
  request: {
    params: z.object({
      base: z.string().openapi({
        param: { name: "base", in: "path" },
        example: "posts",
      }),
    }),
    query: z.object({
      limit: z.string().optional().openapi({
        param: { name: "limit", in: "query" },
        description: "Page size, clamped to 1–500 (default 100).",
        example: "100",
      }),
      offset: z.string().optional().openapi({
        param: { name: "offset", in: "query" },
        description: "Items to skip (default 0).",
        example: "0",
      }),
    }),
  },
  responses: {
    200: jsonContent(NoteListSchema, "A page of notes."),
    404: jsonContent(ErrorSchema, "Base not found."),
  },
});
app.openapi(listNotesRoute, async (c) => {
  const route = c.req.param("base").toLowerCase();
  const index = await getIndex();
  const bd = index.baseData.get(route);
  if (!bd) return c.json({ error: "base not found" }, 404);

  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 500);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  const page = bd.items.slice(offset, offset + limit);

  return c.json(
    {
      base: route,
      total: bd.items.length,
      limit,
      offset,
      items: page.map(({ slug, note }) => listItem(slug, note)),
    },
    200,
  );
});

const getNoteRoute = createRoute({
  method: "get",
  path: "/api/{base}/{id}",
  summary: "Get one note",
  request: {
    params: z.object({
      base: z.string().openapi({
        param: { name: "base", in: "path" },
        example: "posts",
      }),
      id: z.string().openapi({
        param: { name: "id", in: "path" },
        example: "hello-world",
      }),
    }),
  },
  responses: {
    200: jsonContent(NoteSchema, "The note."),
    404: jsonContent(ErrorSchema, "Base or note not found."),
  },
});
app.openapi(getNoteRoute, async (c) => {
  const route = c.req.param("base").toLowerCase();
  const id = c.req.param("id");
  const index = await getIndex();
  const bd = index.baseData.get(route);
  if (!bd) return c.json({ error: "base not found" }, 404);
  const note = bd.bySlug.get(id);
  if (!note) return c.json({ error: "not found" }, 404);

  return c.json(
    {
      id,
      title: titleOf(note),
      frontmatter: note.frontmatter,
      body: note.body,
      assets: assetMap(index, note),
    },
    200,
  );
});

// ---- write --------------------------------------------------------------

const createNoteRoute = createRoute({
  method: "post",
  path: "/api/{base}",
  summary: "Create a note",
  security: [{ Bearer: [] }],
  request: {
    params: z.object({
      base: z.string().openapi({
        param: { name: "base", in: "path" },
        example: "posts",
      }),
    }),
    body: {
      content: { "application/json": { schema: CreateBodySchema } },
      required: true,
    },
  },
  responses: {
    201: jsonContent(CreateResultSchema, "Created."),
    400: jsonContent(ErrorSchema, "Invalid body."),
    401: jsonContent(ErrorSchema, "Missing or invalid bearer token."),
    404: jsonContent(ErrorSchema, "Base not found."),
    409: jsonContent(ErrorSchema, "A note with that name already exists."),
  },
});
// Unparseable JSON would otherwise throw past the zod validator into onError
// as a 500. The parse result is cached, so the validator does not re-parse.
app.post("/api/:base", async (c, next) => {
  try {
    await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  await next();
});

app.openapi(createNoteRoute, async (c) => {
  if (!checkBearer(c.req.header("authorization"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const route = c.req.param("base").toLowerCase();
  const index = await getIndex();
  const bd = index.baseData.get(route);
  if (!bd) return c.json({ error: "base not found" }, 404);

  const payload = c.req.valid("json");
  const safe = payload.title.replace(/[\/\\]/g, " ").replace(/[\x00-\x1f]/g, "")
    .replace(/\s+/g, " ").trim();
  if (!safe || safe === "." || safe === "..") {
    return c.json({ error: "title is required" }, 400);
  }
  const body = payload.body ?? "";
  const extra = payload.frontmatter ?? {};

  const abs = `${VAULT}/${safe}.md`;
  try {
    await Deno.stat(abs);
    return c.json({ error: "a note with that name already exists" }, 409);
  } catch { /* does not exist -> ok */ }

  const fm = { ...extra, categories: `[[${bd.base.name}.base]]` };
  const content = `---\n${stringify(fm)}---\n\n${body}\n`;

  try {
    await Deno.writeTextFile(abs, content, { createNew: true });
  } catch (e) {
    if (e instanceof Deno.errors.AlreadyExists) {
      return c.json({ error: "a note with that name already exists" }, 409);
    }
    throw e;
  }

  await refreshNow();

  const pub = typeof extra.public === "string" && extra.public.trim()
    ? extra.public.trim()
    : null;
  return c.json(
    {
      created: `${safe}.md`,
      base: route,
      id: pub, // present only if the note is public (GET-readable)
    },
    201,
  );
});

// ---- error handling -----------------------------------------------------

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  console.error(`[error] ${c.req.method} ${c.req.path}:`, err);
  return c.json({ error: "internal error" }, 500);
});

// ---- boot ---------------------------------------------------------------

if (import.meta.main) {
  warmup().catch((e) => console.error("[boot] warmup failed:", e));
  console.log(
    `obsidian-bases-api listening on :${PORT} (writes ${
      API_KEY ? "enabled" : "DISABLED — no API_KEY"
    })`,
  );
  Deno.serve({ port: PORT }, app.fetch);
}

export { app };
