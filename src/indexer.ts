import { ASSETS_DIR, VAULT } from "./config.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { type Base, loadBases, matches, type SortSpec } from "./bases.ts";
import { type EvalContext, normLink } from "./expr.ts";

export interface Note {
  absPath: string;
  relPath: string;
  name: string; // filename without .md
  frontmatter: Record<string, unknown>;
  body: string;
  mtime: number;
  size: number;
  links: string[]; // normalized outgoing wikilink basenames (body + frontmatter)
}

export interface ReachableItem {
  slug: string;
  note: Note;
}

export interface BaseData {
  base: Base;
  items: ReachableItem[]; // deduped, sorted; excludes collisions & invalid slugs
  bySlug: Map<string, Note>;
  collisions: string[];
}

export interface VaultIndex {
  notes: Note[];
  bases: Base[];
  baseData: Map<string, BaseData>; // key = base.route
  assetsByName: Map<string, string>; // lowercased filename -> abs path
  allowedAssets: Set<string>; // lowercased filenames referenced by reachable notes
  builtAt: number;
}

function toCtx(n: Note): EvalContext {
  return {
    frontmatter: n.frontmatter,
    name: n.name,
    relPath: n.relPath,
    mtime: n.mtime,
    size: n.size,
    links: n.links,
  };
}

const LINK_RE = /\[\[([^\]]+)\]\]/g;

/** Outgoing wikilink targets, normalized to basenames, from a note's body
 * and frontmatter values. Backs file.hasLink() in base filters. */
export function outgoingLinks(
  body: string,
  fm: Record<string, unknown>,
): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(LINK_RE)) out.add(normLink(m[1]));
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(LINK_RE)) out.add(normLink(m[1]));
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(fm);
  return [...out];
}

/** A note opts in via the `public` key, but an explicit `public: false`
 * (or `no`, which YAML parses to false) means private. Bare `public:` (null),
 * `public: true` and string slugs remain public. */
export function isPublic(fm: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(fm, "public") &&
    fm.public !== false;
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Resolve a note's slug, or null if the `public` value is invalid. */
function computeSlug(n: Note): string | null {
  const pub = n.frontmatter.public;
  if (typeof pub === "string" && pub.trim() !== "") {
    const s = pub.trim();
    if (s.includes("/")) {
      console.warn(
        `[index] invalid slug (contains '/'), excluding note: ${n.relPath} -> "${s}"`,
      );
      return null;
    }
    return s;
  }
  return slugify(n.name);
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name.startsWith(".")) continue; // skip .obsidian, .trash, etc.
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walkFiles(p);
    else if (entry.isFile) yield p;
  }
}

/** Stat-level fingerprint of the vault: path + mtime + size of every file
 * (notes, assets, .base files). A stat walk is ~an order of magnitude cheaper
 * than a full read-and-parse rebuild, and changes whenever any file is added,
 * removed, or touched — regardless of what made the change. */
export async function vaultFingerprint(): Promise<string> {
  const parts: string[] = [];
  for await (const abs of walkFiles(VAULT)) {
    try {
      const s = await Deno.stat(abs);
      parts.push(`${abs}:${s.mtime?.getTime() ?? 0}:${s.size}`);
    } catch {
      // deleted mid-walk
    }
  }
  parts.sort();
  let h = 2166136261; // FNV-1a
  const joined = parts.join("\n");
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${parts.length}:${(h >>> 0).toString(16)}`;
}

async function loadNotes(): Promise<Note[]> {
  const notes: Note[] = [];
  for await (const abs of walkFiles(VAULT)) {
    if (!abs.endsWith(".md")) continue;
    let stat: Deno.FileInfo;
    let raw: string;
    try {
      stat = await Deno.stat(abs);
      raw = await Deno.readTextFile(abs);
    } catch {
      continue;
    }
    const { data, body } = parseFrontmatter(raw);
    const relPath = abs.slice(VAULT.length + 1);
    const name = (relPath.split("/").pop() ?? "").replace(/\.md$/, "");
    notes.push({
      absPath: abs,
      relPath,
      name,
      frontmatter: data,
      body,
      mtime: stat.mtime?.getTime() ?? 0,
      size: stat.size,
      links: outgoingLinks(body, data),
    });
  }
  return notes;
}

async function loadAssets(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    for await (const abs of walkFiles(ASSETS_DIR)) {
      const fname = abs.split("/").pop() ?? "";
      map.set(fname.toLowerCase(), abs);
    }
  } catch {
    // no assets dir yet
  }
  return map;
}

const EMBED_RE = /!\[\[([^\]]+)\]\]/g;

/** Normalize a wikilink target to a bare asset filename, or null when it
 * points at another note/base (a transclusion, not an asset). */
function assetTarget(raw: string): string | null {
  let t = raw.split("|")[0].split("#")[0].trim();
  t = t.split("/").pop() ?? t;
  if (/\.(md|base)$/i.test(t) || !t.includes(".")) return null;
  return t;
}

/** Bare asset filenames referenced by a note: body embeds (`![[x.png]]`)
 * plus wikilinks in frontmatter values (`cover: "[[x.png]]"`). */
export function referencedAssets(
  body: string,
  fm: Record<string, unknown>,
): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(EMBED_RE)) {
    const t = assetTarget(m[1]);
    if (t) out.add(t);
  }
  // LINK_RE also matches the inner part of `![[...]]`, so frontmatter
  // embeds and plain property links are both covered.
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(LINK_RE)) {
        const t = assetTarget(m[1]);
        if (t) out.add(t);
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(fm);
  return [...out];
}

function sortItems(items: ReachableItem[], sort: SortSpec[]): void {
  if (sort.length === 0) {
    items.sort((a, b) => a.note.name.localeCompare(b.note.name));
    return;
  }
  const val = (n: Note, prop: string): unknown => {
    if (prop.startsWith("file.")) {
      const f = prop.slice(5);
      if (f === "name" || f === "basename") return n.name;
      if (f === "path") return n.relPath;
      if (f === "mtime" || f === "ctime") return n.mtime;
      if (f === "size") return n.size;
      return null;
    }
    return n.frontmatter[prop] ?? null;
  };
  items.sort((a, b) => {
    for (const s of sort) {
      const av = val(a.note, s.property);
      const bv = val(b.note, s.property);
      let c: number;
      if (av == null && bv == null) c = 0;
      else if (av == null) c = 1;
      else if (bv == null) c = -1;
      else if (typeof av === "number" && typeof bv === "number") c = av - bv;
      else c = String(av).localeCompare(String(bv));
      if (c !== 0) return s.direction === "DESC" ? -c : c;
    }
    return 0;
  });
}

function computeBaseData(base: Base, notes: Note[]): BaseData {
  const candidates = notes.filter((n) =>
    isPublic(n.frontmatter) && matches(base.filter, toCtx(n))
  );
  const grouped = new Map<string, Note[]>();
  for (const n of candidates) {
    const slug = computeSlug(n);
    if (slug === null) continue;
    (grouped.get(slug) ?? grouped.set(slug, []).get(slug)!).push(n);
  }
  const items: ReachableItem[] = [];
  const bySlug = new Map<string, Note>();
  const collisions: string[] = [];
  for (const [slug, group] of grouped) {
    if (group.length > 1) {
      collisions.push(slug);
      console.warn(
        `[index] slug collision in base "${base.route}": "${slug}" -> ${
          group.map((g) => g.relPath).join(", ")
        }`,
      );
      continue;
    }
    items.push({ slug, note: group[0] });
    bySlug.set(slug, group[0]);
  }
  sortItems(items, base.sort);
  return { base, items, bySlug, collisions };
}

/** Build the full in-memory index from the current vault contents. */
export async function buildIndex(): Promise<VaultIndex> {
  const [notes, bases, assetsByName] = await Promise.all([
    loadNotes(),
    loadBases(),
    loadAssets(),
  ]);

  const baseData = new Map<string, BaseData>();
  for (const base of bases) {
    baseData.set(base.route, computeBaseData(base, notes));
  }

  // Global reachable set = any note reachable through at least one base.
  const reachable = new Set<Note>();
  for (const bd of baseData.values()) {
    for (const item of bd.items) reachable.add(item.note);
  }

  const allowedAssets = new Set<string>();
  for (const n of reachable) {
    for (const ref of referencedAssets(n.body, n.frontmatter)) {
      const key = ref.toLowerCase();
      if (assetsByName.has(key)) allowedAssets.add(key);
    }
  }

  return {
    notes,
    bases,
    baseData,
    assetsByName,
    allowedAssets,
    builtAt: Date.now(),
  };
}
