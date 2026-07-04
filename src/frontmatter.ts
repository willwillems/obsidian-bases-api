import { parse } from "@std/yaml";

export interface ParsedNote {
  data: Record<string, unknown>;
  body: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Split a markdown file into YAML frontmatter + body. */
export function parseFrontmatter(raw: string): ParsedNote {
  if (!raw.startsWith("---")) return { data: {}, body: raw };
  const m = raw.match(FM_RE);
  if (!m) return { data: {}, body: raw };
  let data: Record<string, unknown> = {};
  try {
    const parsed = parse(m[1]);
    if (parsed && typeof parsed === "object") {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // malformed frontmatter -> treat as no properties
    data = {};
  }
  return { data, body: raw.slice(m[0].length) };
}
