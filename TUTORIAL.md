# Tutorial: serve your Obsidian vault as an API from a Sprite

Turn an Obsidian vault into a public read API (with key-gated writes) running
on a [Sprite](https://sprites.dev) — a VM that pauses when idle and wakes
automatically on incoming HTTP requests, so it costs nothing while nobody is
calling it.

## 1. Create a sprite

Create a sprite from your own machine and open a session on it (see the
Sprites docs). Everything below runs **inside** the sprite unless noted.

## 2. Sync your vault onto the sprite

The API uses [`obsidian-headless`](https://www.npmjs.com/package/obsidian-headless)
(`ob`) with Obsidian Sync as the transport: pull before serving, push after
writes.

```bash
npm install -g obsidian-headless
ob login                                  # Obsidian account with Sync
ob sync-setup --vault <name> --path ~/vault
ob sync                                   # first pull
```

## 3. Clone and check the package

```bash
git clone https://github.com/willwillems/obsidian-bases-api ~/api
cd ~/api && deno task test
```

## 4. Shape the vault

- **Routes come from Bases**: every `Templates/Bases/<Name>.base` becomes
  `/api/<name>`. A base's `filters` decide which notes belong to it.
- **Notes opt in** with a `public` frontmatter key whose value is a non-empty
  string: the note's slug (`/api/<base>/<slug>`). Anything else (`public: true`,
  a bare `public:`, `public: false`) keeps it private. Everything else — and
  every asset not referenced by a public note — is never served.

## 5. Create the service

```bash
OB_BIN=$(command -v ob)
API_KEY=$(openssl rand -hex 32)   # keep this — it gates POST

sprite-env services create obsidian-api \
  --dir $HOME/api \
  --cmd $(command -v deno) \
  --args "run,--allow-net,--allow-env,--allow-run=$OB_BIN,--allow-read=$HOME/vault,--allow-write=$HOME/vault,src/main.ts" \
  --env "API_KEY=$API_KEY,OB_BIN=$OB_BIN,HOME=$HOME,PATH=$PATH" \
  --http-port 8080
```

`--http-port 8080` is the key bit: the sprite's HTTPS proxy routes
`https://<sprite>.sprites.app/*` to this port and **auto-starts the service
(waking the whole sprite) when a request arrives**. Only one service per
sprite can hold it.

> `ob` is a Node script installed under your current Node version — the
> `OB_BIN`/`PATH` values are pinned at create time, so recreate or edit the
> service env if you switch Node versions.

## 6. Open it up (optional)

By default the sprite URL is only reachable by your org. To make it public,
run **from your own machine** (the in-VM CLI can't change this):

```bash
sprite update --url-auth public
```

## 7. Use it

```bash
curl https://<sprite>.sprites.app/api                 # list bases
curl https://<sprite>.sprites.app/api/posts           # list notes in a base
curl https://<sprite>.sprites.app/api/posts/my-slug   # one note (+ asset URLs)

curl -X POST https://<sprite>.sprites.app/api/posts \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "Hello", "body": "From the API", "frontmatter": {"public": "hello"}}'
```

Reads are public; every request pulls vault changes (debounced, default 10 s)
and rebuilds the index only when something changed. Writes push back through
`ob sync` immediately. `/api/_health` shows counts and sync state,
`/api/openapi.json` serves the full spec for tooling and agents.
