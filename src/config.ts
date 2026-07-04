export const VAULT = Deno.env.get("VAULT") ?? "/home/sprite/vault";
export const BASES_DIR = `${VAULT}/Templates/Bases`;
export const ASSETS_DIR = `${VAULT}/assets`;
export const PORT = Number(Deno.env.get("PORT") ?? 8080);
export const SYNC_TTL_MS = Number(Deno.env.get("SYNC_TTL_MS") ?? 10_000);
export const OB_BIN = Deno.env.get("OB_BIN") ?? "ob";
/** Bearer key required for writes. Empty => all writes rejected. */
export const API_KEY = Deno.env.get("API_KEY") ?? "";
