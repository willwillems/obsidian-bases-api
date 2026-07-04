import { parse } from "@std/yaml";
import { BASES_DIR } from "./config.ts";
import { type EvalContext, evalExpr, validateExpr } from "./expr.ts";

export type Filter =
  | { and: Filter[] }
  | { or: Filter[] }
  | { not: Filter }
  | { expr: string };

export interface SortSpec {
  property: string;
  direction: "ASC" | "DESC";
}

export interface Base {
  name: string; // e.g. "Posts"
  route: string; // e.g. "posts"
  filter: Filter | null;
  sort: SortSpec[];
  /** Filter expressions that fail to parse. Each one evaluates as false at
   * match time (fail closed), so a non-empty list explains a shrunken base. */
  filterErrors: string[];
}

/** Turn the raw YAML `filters` node into a Filter tree. */
function normalizeFilter(node: unknown): Filter | null {
  if (node == null) return null;
  if (typeof node === "string") return { expr: node };
  if (Array.isArray(node)) {
    // a bare list is treated as AND
    return { and: node.map(normalizeFilter).filter(Boolean) as Filter[] };
  }
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if ("and" in o) {
      return {
        and: asArray(o.and).map(normalizeFilter).filter(Boolean) as Filter[],
      };
    }
    if ("or" in o) {
      return {
        or: asArray(o.or).map(normalizeFilter).filter(Boolean) as Filter[],
      };
    }
    if ("not" in o) {
      const inner = Array.isArray(o.not)
        ? { and: o.not.map(normalizeFilter).filter(Boolean) as Filter[] }
        : normalizeFilter(o.not);
      return inner ? { not: inner } : null;
    }
  }
  return null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

function normalizeSort(node: unknown): SortSpec[] {
  if (!Array.isArray(node)) return [];
  const out: SortSpec[] = [];
  for (const item of node) {
    if (typeof item === "string") {
      out.push({ property: item, direction: "ASC" });
      continue;
    }
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      if (typeof o.property === "string") {
        const dir = String(o.direction ?? "ASC").toUpperCase() === "DESC"
          ? "DESC"
          : "ASC";
        out.push({ property: o.property, direction: dir });
      }
    }
  }
  return out;
}

function collectFilterErrors(f: Filter | null, out: string[]): void {
  if (!f) return;
  if ("and" in f) f.and.forEach((c) => collectFilterErrors(c, out));
  else if ("or" in f) f.or.forEach((c) => collectFilterErrors(c, out));
  else if ("not" in f) collectFilterErrors(f.not, out);
  else {
    const err = validateExpr(f.expr);
    if (err) out.push(`"${f.expr}": ${err}`);
  }
}

/** Parse one `.base` file's YAML into a Base. */
export function parseBase(name: string, yaml: string): Base {
  const doc = parse(yaml) as Record<string, unknown> | null;
  const views = (doc?.views as unknown[]) ?? [];
  const view = (views[0] as Record<string, unknown>) ?? {};
  const filter = normalizeFilter(view.filters);
  const filterErrors: string[] = [];
  collectFilterErrors(filter, filterErrors);
  return {
    name,
    route: name.toLowerCase(),
    filter,
    sort: normalizeSort(view.sort),
    filterErrors,
  };
}

/** Evaluate a filter tree against a note. Any expression error fails closed
 * (that branch is treated as non-matching) and is logged once. */
export function matches(filter: Filter | null, ctx: EvalContext): boolean {
  if (!filter) return true; // no filter => everything in the base
  if ("and" in filter) return filter.and.every((f) => matches(f, ctx));
  if ("or" in filter) return filter.or.some((f) => matches(f, ctx));
  if ("not" in filter) return !matches(filter.not, ctx);
  try {
    return evalExpr(filter.expr, ctx);
  } catch (e) {
    warnOnce(filter.expr, e);
    return false;
  }
}

const warned = new Set<string>();
function warnOnce(expr: string, e: unknown) {
  if (warned.has(expr)) return;
  warned.add(expr);
  console.warn(
    `[bases] filter expression failed, treating as false: "${expr}" (${
      e instanceof Error ? e.message : e
    })`,
  );
}

/** Load and parse every `.base` file under Templates/Bases. */
export async function loadBases(dir = BASES_DIR): Promise<Base[]> {
  const bases: Base[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".base")) continue;
    const name = entry.name.replace(/\.base$/, "");
    const yaml = await Deno.readTextFile(`${dir}/${entry.name}`);
    try {
      bases.push(parseBase(name, yaml));
    } catch (e) {
      console.warn(
        `[bases] failed to parse ${entry.name}: ${
          e instanceof Error ? e.message : e
        }`,
      );
    }
  }
  bases.sort((a, b) => a.route.localeCompare(b.route));
  return bases;
}
