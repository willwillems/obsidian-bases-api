import { assertEquals } from "jsr:@std/assert@^1";
import { matches, parseBase } from "./bases.ts";
import { type EvalContext } from "./expr.ts";

function ctx(fm: Record<string, unknown>): EvalContext {
  return {
    frontmatter: fm,
    name: "Note",
    relPath: "Note.md",
    mtime: 0,
    size: 0,
  };
}

Deno.test("parseBase reads filter + sort from a view", () => {
  const yaml = `views:
  - type: table
    name: Table
    filters:
      and:
        - categories.contains(link("Research"))
    sort:
      - property: updated
        direction: DESC
`;
  const base = parseBase("Research", yaml);
  assertEquals(base.route, "research");
  assertEquals(base.sort, [{ property: "updated", direction: "DESC" }]);
  assertEquals(matches(base.filter, ctx({ categories: "[[Research]]" })), true);
  assertEquals(matches(base.filter, ctx({ categories: "[[Posts]]" })), false);
});

Deno.test("template-exclusion clause works and errors are collected", () => {
  const yaml = `views:
  - type: table
    filters:
      and:
        - categories.contains(link("Posts"))
        - '!file.name.contains("Template")'
`;
  const base = parseBase("Posts", yaml);
  assertEquals(base.filterErrors, []);
  assertEquals(matches(base.filter, ctx({ categories: "[[Posts]]" })), true);
  const tpl = { ...ctx({ categories: "[[Posts]]" }), name: "Post Template" };
  assertEquals(matches(base.filter, tpl), false);

  const bad = parseBase(
    "Bad",
    `views:\n  - filters:\n      and:\n        - "status ~ done"\n`,
  );
  assertEquals(bad.filterErrors.length, 1);
});
