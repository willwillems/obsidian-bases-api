import { API_KEY } from "./config.ts";

function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let r = 0;
  for (let i = 0; i < ea.length; i++) r |= ea[i] ^ eb[i];
  return r === 0;
}

/** Validate a Bearer token against API_KEY. Writes are rejected entirely when
 * no key is configured. */
export function checkBearer(authHeader: string | undefined): boolean {
  if (!API_KEY) return false;
  const m = (authHeader ?? "").match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return safeEqual(m[1], API_KEY);
}
