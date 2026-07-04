import { OB_BIN, SYNC_TTL_MS, VAULT } from "./config.ts";
import { buildIndex, vaultFingerprint, type VaultIndex } from "./indexer.ts";

let index: VaultIndex | null = null;
let building: Promise<VaultIndex> | null = null;

let lastSync = 0;
let syncing: Promise<boolean> | null = null;

let lastFingerprint = "";
let lastCheck = 0; // when the vault was last fingerprinted

export function getState() {
  return { lastSync, builtAt: index?.builtAt ?? 0, lastCheck };
}

async function runObSync(): Promise<void> {
  try {
    const cmd = new Deno.Command(OB_BIN, {
      args: ["sync"],
      cwd: VAULT,
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    if (code !== 0) {
      console.error(
        `[sync] ob sync exited ${code}: ${
          new TextDecoder().decode(stderr).trim()
        }`,
      );
    }
  } catch (e) {
    console.error(
      `[sync] ob sync failed to run: ${e instanceof Error ? e.message : e}`,
    );
  }
}

/** Run `ob sync`, debounced to SYNC_TTL_MS. Returns whether a sync ran.
 * Concurrent callers share a single in-flight sync; a forced call made while
 * one is in flight chains a fresh sync after it, since the in-flight run may
 * predate the write the caller needs pushed. */
export function syncIfStale(force = false): Promise<boolean> {
  if (syncing) {
    if (!force) return syncing;
    return syncing.then(() => syncIfStale(true));
  }
  if (!force && Date.now() - lastSync < SYNC_TTL_MS) {
    return Promise.resolve(false);
  }
  syncing = runObSync()
    .then(() => true)
    .finally(() => {
      lastSync = Date.now();
      syncing = null;
    });
  return syncing;
}

function rebuild(fp?: string): Promise<VaultIndex> {
  if (building) return building;
  building = (async () => {
    // Fingerprint before reading contents: a change landing mid-build makes
    // the next check mismatch and rebuild again — never skip.
    lastFingerprint = fp ?? (await vaultFingerprint());
    lastCheck = Date.now();
    const i = await buildIndex();
    index = i;
    return i;
  })().finally(() => {
    building = null;
  });
  return building;
}

/** Get the current index, syncing (debounced) and rebuilding only when the
 * vault's stat fingerprint actually changed since the last build. */
export async function getIndex(): Promise<VaultIndex> {
  const didSync = await syncIfStale();
  if (!index) return rebuild();
  if (!didSync) return index;
  const fp = await vaultFingerprint();
  lastCheck = Date.now();
  if (fp === lastFingerprint) return index;
  return rebuild(fp);
}

/** Force a sync + rebuild (used after writes). */
export async function refreshNow(): Promise<VaultIndex> {
  await syncIfStale(true);
  return rebuild();
}

/** Build the index once at startup without blocking on a slow first request. */
export async function warmup(): Promise<void> {
  await getIndex();
}
