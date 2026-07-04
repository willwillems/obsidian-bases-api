# obsidian-bases-api

Read-mostly HTTP API over the Obsidian vault at `/home/sprite/vault`, derived
from the Bases in `Templates/Bases/*.base`. Deno + Hono, runs as the Sprite
service `obsidian-api` on port 8080. See `SPEC.md` for the full design and
`TUTORIAL.md` for setting this up on your own Sprite from scratch.

## Model

- A note is **GET-readable** iff it has a `public` frontmatter key (with any
  value except an explicit `false`) **and**
  matches a base's filter. The `public` value is its slug
  (`/api/<base>/<slug>`); empty `public` falls back to the slugified filename;
  a slug containing `/` is rejected.
- **GET is public** (no auth). **POST requires** `Authorization: Bearer <API_KEY>`.
- Every request triggers `ob sync` (debounced to `SYNC_TTL_MS`, default 10s);
  the in-memory index rebuilds when the vault changes. POST syncs immediately.

## Endpoints

| Method | Path | Auth | |
|---|---|---|---|
| GET  | `/api` | — | list bases |
| GET  | `/api/:base` | — | list reachable notes (`?limit`, `?offset`) |
| GET  | `/api/:base/:id` | — | one note: `{id, title, frontmatter, body, assets}` |
| GET  | `/api/assets/:filename` | — | asset, only if referenced by a reachable note |
| POST | `/api/:base` | Bearer | create `{title, body?, frontmatter?}`; 409 if name exists |
| GET  | `/api/_health` | — | counts, collisions, last sync |
| GET  | `/api/openapi.json` | — | OpenAPI 3.1 spec (for agents/tooling) |

The spec is generated from the route definitions via `@hono/zod-openapi` — the
Zod schemas in `src/schemas.ts` are the single source of truth. `POST` bodies are
validated against `CreateNoteBody`, so a malformed body returns a structured Zod
`{success:false, error}` 400 (auth is still checked first for well-formed bodies).

## Operating

```bash
sprite-env services get obsidian-api        # status + config (incl. API_KEY)
sprite-env services restart obsidian-api    # after code changes
tail -f /.sprite/logs/services/obsidian-api.log
```

The API key lives in the service's `API_KEY` env var (recoverable via
`services get`). To rotate: `services delete` + recreate with a new key, or edit
the env and restart.

## Config (env vars)

- `API_KEY` — Bearer key for writes (empty ⇒ writes disabled).
- `OB_BIN` — path to the `ob` binary (pinned to the current Node version).
- `SYNC_TTL_MS` — sync debounce window (default 10000).
- `VAULT`, `PORT`, `HOME` — paths/port.

> Note: `OB_BIN` / `PATH` are pinned to the current nvm Node version. If the
> default Node version changes, update the service env.

## Tests

```bash
deno task test
```

Tests that depend on the author's actual vault contents live in
`src/local_test.ts`, which is gitignored — the tracked tests are
self-contained.
