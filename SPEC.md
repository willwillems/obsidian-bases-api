# Obsidian Bases API — SPEC

Status: **implemented** (Sprite service `obsidian-api`, port 8080; see
`README.md`). Serves a read-mostly HTTP API over an
Obsidian vault, derived from the Bases defined in `Templates/Bases/*.base`.
Runs as a single Sprite service; the Sprite wakes on HTTP request and pauses
when idle.

## Goals

- Expose each Obsidian Base as an API resource: `Bases/Posts` → `/api/posts`,
  a single note → `/api/posts/{identifier}`.
- Keep the Obsidian vault (`~/vault`) as the source of truth; `ob sync` is the
  transport. Pull before serving, push after writing.
- Read access is public; write access is key-gated.

## Stack

- **Deno 2.8 + Hono**, single service on `--http-port 8080`.
- Vault at `/home/sprite/vault`.
- No database — an in-memory index of parsed notes, rebuilt when the vault
  changes.

## Access model

A note is **reachable over GET** iff **both**:
1. it has a `public` frontmatter key whose value is not an explicit `false`
   (`public: false` / `public: no` means private), **and**
2. it matches at least one base's filter (reached via that base's route).

- **Identifier / slug** = the `public` value. If `public` is present but empty,
  fall back to the slugified filename.
- **Slug collisions** (two reachable notes resolve to the same slug within a
  base): serve *neither*, log it, and surface it in `/api/_health`.
- **GET is public** (no auth). The `public` flag is the opt-in; notes without it
  (e.g. Daily, Meetings) never surface even though all bases are routed.
- **POST is Bearer-key gated.** Key generated at setup, stored as the service's
  `API_KEY` env var, shown once, never exposed over HTTP.

## Routes

| Method | Path | Auth | Behavior |
|---|---|---|---|
| GET  | `/api` | public | list available bases |
| GET  | `/api/:base` | public | list of reachable notes for the base: `{ id, title, frontmatter, excerpt }`; respects the base's `sort`; supports `?limit` & `?offset` |
| GET  | `/api/:base/:id` | public | one note: `{ id, title, frontmatter, body, assets }` (raw markdown + asset map) |
| GET  | `/api/assets/:filename` | public | serve an asset **iff** it is referenced by a reachable public note; 404 otherwise |
| POST | `/api/:base` | **Bearer** | create note from `{ title, body, frontmatter? }`; sets `categories: "[[<Base>.base]]"`; **409** if name/slug already exists; note is public only if the caller passes a `public` field |
| GET  | `/api/_health` | public | base list, note counts, slug collisions, last-sync time — **no secrets** |

- `:base` maps case-insensitively to `Templates/Bases/<Base>.base`.
- New notes from POST land at **vault root** (TBD: dedicated folder?).

## Bases evaluator

- Parse the `.base` YAML; use the default view's `filters` (an `and`/`or`/`not`
  tree of leaf expressions).
- Leaf operators, covering the subset the current bases use, built to extend:
  - `prop.contains(link("X"))`
  - `prop.contains("x")`
  - `tags.contains("x")`
  - comparisons (`==`, `!=`, `>`, `<`), `file.name`
- **Link matching**: `link("Posts")` matches a frontmatter link value such as
  `[[Posts.base]]`, `[[Posts]]`, or `[[Categories/Posts]]` by comparing
  basenames, ignoring path and extension, case-insensitively. (Current notes
  link `categories: "[[Posts.base]]"` while filters say `link("Posts")` — this
  loose match reconciles them.)
- Apply the base's `sort` / `order`.

## Sync

- **Debounced per-request**: on a request, if `now - lastSync > 10s`, run
  `ob sync` (pull), then rebuild the index if files changed. Single-flight
  mutex so concurrent requests share one in-flight sync.
- **POST**: write file → `ob sync` (push, bypasses debounce) → rebuild index →
  `201`.

## Response shapes

- List item: `{ id, title, frontmatter: {...}, excerpt }` (excerpt ≈ first ~200
  chars of body, markdown stripped).
- Single note: `{ id, title, frontmatter: {...}, body, assets }`.
  - `body` is raw markdown, unchanged (embeds stay as `![[filename]]`).
  - `assets` maps each referenced asset's bare filename to its public URL, e.g.
    `{ "IMG_4640.jpeg": "/api/assets/IMG_4640.jpeg" }`. The consumer resolves
    embeds itself.

## Assets

- **Assumption:** all attachments live under `assets/` with **unique
  filenames** (user is migrating the vault to this layout). Resolution of a bare
  embed (`![[IMG_4640.jpeg]]`) is therefore a filename lookup within `assets/`.
- **URL scheme:** `/api/assets/<filename>` (filenames are unique, so no path).
- **Access gate (non-negotiable):** an asset is served **only if** it is
  referenced by at least one *reachable* note (public + base-matched). Build the
  allowlist during indexing; every other file under `assets/` (and anywhere else
  in the vault) 404s. This prevents private attachments (e.g. `Brief.pdf`,
  scanned PDFs) from leaking over the public GET surface.
- Only **non-markdown** embed targets are treated as assets; `![[Some Note]]`
  transclusions of other notes are out of scope for now.
- Serve with correct `Content-Type`, `ETag`, and long-lived `Cache-Control`;
  support range requests for large PDFs/media.

## POST contract

- Auth: `Authorization: Bearer <API_KEY>`, constant-time compare.
- Body: `{ title: string (required), body?: string, frontmatter?: object }`.
- Server sets `categories: "[[<Base>.base]]"`; merges caller `frontmatter`.
- Filename derived from `title`, sanitized against path traversal.
- **409 Conflict** if a note with that name/slug already exists (never
  overwrite, never auto-suffix).
- Note is GET-readable only if the caller included a `public` value.

## Security

- Never expose `API_KEY`; `/api/_health` returns no secrets.
- Generic error messages (no filesystem paths or stack traces in responses);
  details logged server-side.
- Deno permissions scoped: `--allow-net`,
  `--allow-read=/home/sprite/vault`, `--allow-write=/home/sprite/vault`,
  `--allow-run=ob`, `--allow-env`.

## Project layout

```
~/api/
  main.ts      # Hono app + server
  vault.ts     # index build, frontmatter parse
  bases.ts     # .base parse + filter evaluator
  sync.ts      # debounced ob sync wrapper
  auth.ts      # bearer check
  deno.json    # tasks, imports
```

## Deployment

- Service:
  `sprite-env services create obsidian-api --cmd deno --args "run,--allow-net,--allow-read=/home/sprite/vault,--allow-write=/home/sprite/vault,--allow-run=ob,--allow-env,/home/sprite/api/main.ts" --http-port 8080`
  with `API_KEY` injected.
- **Manual step (user):** flip the URL to serve without a Sprite token via
  `sprite update --url-auth public` from an authenticated CLI (the in-VM
  `sprite url` cannot authenticate). Until then, test via the Bearer-token path.

## Data quirks observed (decided)

- **Slugs are single-segment.** `:id` is one path segment. A `public` value that
  contains `/` is **invalid**: the note is excluded from the API and logged
  (user keeps slugs slash-free).
- **Category links use strict basename matching.** If a note's `categories`
  link doesn't match any base (e.g. `[[Product]]` vs `Products.base`), the note
  is simply unreachable — no special-casing, no health surfacing.

## Decided defaults

- POST creates notes at **vault root**.
- Acceptance bar: `deno test` for the bases evaluator (run against the real
  `.base` files) + curl smoke tests of every route.
