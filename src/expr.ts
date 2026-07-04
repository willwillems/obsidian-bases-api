// A small evaluator for the subset of the Obsidian Bases expression language
// used by the vault's `.base` filters:
//   prop.contains(link("X"))   tags.contains("daily")   file.name == "x"
//   status != "done"           updated > "2026-01-01"    prop.isEmpty()
// It is intentionally narrow and fails *closed* (throws) on anything it does
// not understand, so unsupported syntax is caught rather than silently matching.

export interface EvalContext {
  frontmatter: Record<string, unknown>;
  name: string; // filename without extension
  relPath: string;
  mtime: number;
  size: number;
  /** Normalized basenames of outgoing wikilinks (body + frontmatter).
   * Optional so callers that never use file.hasLink() need not compute it. */
  links?: string[];
}

class Link {
  constructor(public target: string) {}
}
const FILE = Symbol("file");

type Node =
  | { k: "lit"; v: unknown }
  | { k: "prop"; name: string }
  | { k: "member"; obj: Node; name: string }
  | { k: "call"; obj: Node | null; name: string; args: Node[] }
  | { k: "not"; e: Node }
  | { k: "bin"; op: string; l: Node; r: Node };

// ---- tokenizer ----------------------------------------------------------

interface Tok {
  t: string;
  v?: string;
}

function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  const ident = (c: string) => /[A-Za-z0-9_]/.test(c);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      let v = "";
      while (i < s.length && s[i] !== q) {
        if (s[i] === "\\") {
          v += s[i + 1] ?? "";
          i += 2;
        } else v += s[i++];
      }
      i++;
      toks.push({ t: "STR", v });
      continue;
    }
    if (c === "(") {
      toks.push({ t: "LP" });
      i++;
      continue;
    }
    if (c === ")") {
      toks.push({ t: "RP" });
      i++;
      continue;
    }
    if (c === ",") {
      toks.push({ t: "COMMA" });
      i++;
      continue;
    }
    if (c === ".") {
      toks.push({ t: "DOT" });
      i++;
      continue;
    }
    if ("=!<>".includes(c)) {
      let op = c;
      i++;
      if (s[i] === "=") {
        op += "=";
        i++;
      }
      if (op === "=") op = "==";
      toks.push({ t: "OP", v: op });
      continue;
    }
    if (c === "&" || c === "|") {
      if (s[i + 1] !== c) {
        throw new Error(`unexpected char '${c}' in expression: ${s}`);
      }
      toks.push({ t: "OP", v: c + c });
      i += 2;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(s[i + 1] ?? ""))) {
      let v = c;
      i++;
      while (i < s.length && /[0-9.]/.test(s[i])) v += s[i++];
      toks.push({ t: "NUM", v });
      continue;
    }
    if (ident(c)) {
      let v = c;
      i++;
      while (i < s.length && ident(s[i])) v += s[i++];
      toks.push({ t: "IDENT", v });
      continue;
    }
    throw new Error(`unexpected char '${c}' in expression: ${s}`);
  }
  return toks;
}

// ---- parser -------------------------------------------------------------

function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (t: string) => {
    const tok = next();
    if (!tok || tok.t !== t) throw new Error(`expected ${t} in: ${src}`);
    return tok;
  };

  function primary(): Node {
    const tok = next();
    if (!tok) throw new Error(`unexpected end of expression: ${src}`);
    if (tok.t === "STR") return { k: "lit", v: tok.v };
    if (tok.t === "NUM") return { k: "lit", v: Number(tok.v) };
    if (tok.t === "LP") {
      const e = expr();
      expect("RP");
      return e;
    }
    if (tok.t === "IDENT") {
      const name = tok.v!;
      if (name === "true") return { k: "lit", v: true };
      if (name === "false") return { k: "lit", v: false };
      if (name === "null") return { k: "lit", v: null };
      if (peek()?.t === "LP") {
        return { k: "call", obj: null, name, args: argList() };
      }
      return { k: "prop", name };
    }
    throw new Error(`unexpected token '${tok.t}' in: ${src}`);
  }

  function argList(): Node[] {
    expect("LP");
    const args: Node[] = [];
    if (peek()?.t !== "RP") {
      args.push(expr());
      while (peek()?.t === "COMMA") {
        next();
        args.push(expr());
      }
    }
    expect("RP");
    return args;
  }

  function postfix(): Node {
    let node = primary();
    while (peek()?.t === "DOT") {
      next();
      const name = expect("IDENT").v!;
      if (peek()?.t === "LP") {
        node = { k: "call", obj: node, name, args: argList() };
      } else node = { k: "member", obj: node, name };
    }
    return node;
  }

  // precedence (loosest to tightest): || , && , comparison , ! , postfix
  const CMP_OPS = new Set(["==", "!=", "<", ">", "<=", ">="]);
  const isOp = (v: string) => peek()?.t === "OP" && peek().v === v;

  function unary(): Node {
    if (isOp("!")) {
      next();
      return { k: "not", e: unary() };
    }
    return postfix();
  }

  function cmp(): Node {
    const l = unary();
    if (peek()?.t === "OP" && CMP_OPS.has(peek().v!)) {
      const op = next().v!;
      const r = unary();
      return { k: "bin", op, l, r };
    }
    return l;
  }

  function andExpr(): Node {
    let l = cmp();
    while (isOp("&&")) {
      next();
      l = { k: "bin", op: "&&", l, r: cmp() };
    }
    return l;
  }

  function expr(): Node {
    let l = andExpr();
    while (isOp("||")) {
      next();
      l = { k: "bin", op: "||", l, r: andExpr() };
    }
    return l;
  }

  const out = expr();
  if (p !== toks.length) throw new Error(`trailing tokens in: ${src}`);
  return out;
}

// ---- runtime helpers ----------------------------------------------------

function asList(v: unknown): unknown[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Normalize a wikilink / link target to a comparable basename. */
export function normLink(s: string): string {
  let t = s.trim();
  const wl = t.match(/^\[\[(.+?)\]\]$/);
  if (wl) t = wl[1];
  t = t.split("|")[0].split("#")[0];
  t = t.split("/").pop() ?? t;
  t = t.replace(/\.(md|base)$/i, "");
  return t.toLowerCase();
}

function linkMatch(elem: unknown, link: Link): boolean {
  if (typeof elem !== "string") return false;
  return normLink(elem) === normLink(link.target);
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a === b;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function containsImpl(o: unknown, arg: unknown): boolean {
  if (arg instanceof Link) return asList(o).some((e) => linkMatch(e, arg));
  if (typeof o === "string") {
    return o.toLowerCase().includes(String(arg).toLowerCase());
  }
  return asList(o).some((e) => looseEq(e, arg));
}

function isEmptyImpl(o: unknown): boolean {
  return o == null || o === "" || (Array.isArray(o) && o.length === 0);
}

/** Obsidian-style truthiness: null, "", [], false and 0 are falsy. */
function truthy(v: unknown): boolean {
  return !isEmptyImpl(v) && v !== false && v !== 0;
}

function normTag(s: string): string {
  return s.replace(/^#/, "").trim().toLowerCase();
}

function toComparable(v: unknown): number | string {
  if (typeof v === "number") return v;
  const s = String(v);
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const d = Date.parse(s);
  if (!Number.isNaN(d)) return d;
  return s.toLowerCase();
}

function compare(op: string, l: unknown, r: unknown): boolean {
  if (op === "==") return looseEq(l, r);
  if (op === "!=") return !looseEq(l, r);
  const a = toComparable(l), b = toComparable(r);
  if (typeof a === "number" && typeof b === "number") {
    return op === ">"
      ? a > b
      : op === "<"
      ? a < b
      : op === ">="
      ? a >= b
      : a <= b;
  }
  const c = String(a).localeCompare(String(b));
  return op === ">"
    ? c > 0
    : op === "<"
    ? c < 0
    : op === ">="
    ? c >= 0
    : c <= 0;
}

function fileField(ctx: EvalContext, name: string): unknown {
  switch (name) {
    case "name":
    case "basename":
      return ctx.name;
    case "path":
      return ctx.relPath;
    case "folder":
      return ctx.relPath.split("/").slice(0, -1).join("/");
    case "ext":
      return "md";
    case "mtime":
      return ctx.mtime;
    case "ctime":
      return ctx.mtime;
    case "size":
      return ctx.size;
    default:
      return null;
  }
}

function evalNode(n: Node, ctx: EvalContext): unknown {
  switch (n.k) {
    case "lit":
      return n.v;
    case "prop":
      if (n.name === "file") return FILE;
      return ctx.frontmatter[n.name] ?? null;
    case "member": {
      const o = evalNode(n.obj, ctx);
      if (o === FILE) return fileField(ctx, n.name);
      if (o && typeof o === "object" && !Array.isArray(o)) {
        return (o as Record<string, unknown>)[n.name] ?? null;
      }
      return null;
    }
    case "call": {
      if (n.obj === null) {
        if (n.name === "link") {
          return new Link(String(evalNode(n.args[0], ctx)));
        }
        throw new Error(`unsupported function: ${n.name}()`);
      }
      const o = evalNode(n.obj, ctx);
      const a = n.args.map((x) => evalNode(x, ctx));
      if (o === FILE) return fileMethod(ctx, n.name, a);
      switch (n.name) {
        case "contains":
          return containsImpl(o, a[0]);
        case "containsAny":
          return a.some((x) => containsImpl(o, x));
        case "containsAll":
          return a.every((x) => containsImpl(o, x));
        case "isEmpty":
          return isEmptyImpl(o);
        case "startsWith":
          return typeof o === "string" &&
            o.toLowerCase().startsWith(String(a[0]).toLowerCase());
        case "endsWith":
          return typeof o === "string" &&
            o.toLowerCase().endsWith(String(a[0]).toLowerCase());
        default:
          throw new Error(`unsupported method: .${n.name}()`);
      }
    }
    case "not":
      return !truthy(evalNode(n.e, ctx));
    case "bin": {
      if (n.op === "&&") {
        return truthy(evalNode(n.l, ctx)) && truthy(evalNode(n.r, ctx));
      }
      if (n.op === "||") {
        return truthy(evalNode(n.l, ctx)) || truthy(evalNode(n.r, ctx));
      }
      const l = evalNode(n.l, ctx);
      const r = evalNode(n.r, ctx);
      return compare(n.op, l, r);
    }
  }
}

/** Methods called directly on `file`, e.g. file.hasTag("daily"). */
function fileMethod(ctx: EvalContext, name: string, a: unknown[]): boolean {
  switch (name) {
    case "hasTag": {
      // frontmatter tags only (inline #tags in the body are not indexed)
      const tags = asList(ctx.frontmatter.tags).map((t) => normTag(String(t)));
      return a.some((t) => tags.includes(normTag(String(t))));
    }
    case "inFolder": {
      const folder = ctx.relPath.split("/").slice(0, -1).join("/")
        .toLowerCase();
      const want = String(a[0] ?? "").replace(/^\/+|\/+$/g, "").toLowerCase();
      if (want === "") return true;
      return folder === want || folder.startsWith(want + "/");
    }
    case "hasLink": {
      const arg = a[0];
      const want = normLink(arg instanceof Link ? arg.target : String(arg));
      return (ctx.links ?? []).includes(want);
    }
    default:
      throw new Error(`unsupported method: file.${name}()`);
  }
}

const cache = new Map<string, Node>();

/** Evaluate a single Bases filter expression against a note. Throws on
 * unsupported syntax so callers can fail closed. */
export function evalExpr(src: string, ctx: EvalContext): boolean {
  let ast = cache.get(src);
  if (!ast) {
    ast = parse(src);
    cache.set(src, ast);
  }
  return truthy(evalNode(ast, ctx));
}

/** Check that an expression parses; returns the error message, or null if ok.
 * Used to surface broken filters in /api/_health instead of silent 0s. */
export function validateExpr(src: string): string | null {
  try {
    if (!cache.has(src)) cache.set(src, parse(src));
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
