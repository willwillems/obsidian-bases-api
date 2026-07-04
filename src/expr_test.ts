import { assertEquals } from "jsr:@std/assert@^1";
import { type EvalContext, evalExpr, normLink } from "./expr.ts";

function ctx(
  fm: Record<string, unknown>,
  over: Partial<EvalContext> = {},
): EvalContext {
  return {
    frontmatter: fm,
    name: "Note",
    relPath: "Note.md",
    mtime: 0,
    size: 0,
    ...over,
  };
}

Deno.test("link matching normalizes brackets, path and extension", () => {
  assertEquals(normLink("[[Posts.base]]"), "posts");
  assertEquals(normLink("[[Categories/Posts]]"), "posts");
  assertEquals(normLink("[[Posts|alias]]"), "posts");
  assertEquals(normLink("Posts"), "posts");
  assertEquals(normLink("[[Product]]"), "product");
});

Deno.test("contains(link()) matches a wikilink category string", () => {
  const e = 'categories.contains(link("Posts"))';
  assertEquals(evalExpr(e, ctx({ categories: "[[Posts.base]]" })), true);
  assertEquals(evalExpr(e, ctx({ categories: "[[Product]]" })), false);
  assertEquals(evalExpr(e, ctx({ categories: ["[[X]]", "[[Posts]]"] })), true);
  assertEquals(evalExpr(e, ctx({})), false);
});

Deno.test("tags.contains matches array membership", () => {
  const e = 'tags.contains("daily")';
  assertEquals(evalExpr(e, ctx({ tags: ["daily", "log"] })), true);
  assertEquals(evalExpr(e, ctx({ tags: ["weekly"] })), false);
  assertEquals(evalExpr(e, ctx({ tags: "daily" })), true);
});

Deno.test("comparisons on file.name and frontmatter", () => {
  assertEquals(evalExpr('file.name == "Note"', ctx({})), true);
  assertEquals(evalExpr('status != "done"', ctx({ status: "open" })), true);
  assertEquals(evalExpr('status != "done"', ctx({ status: "done" })), false);
  assertEquals(
    evalExpr('updated > "2026-01-01"', ctx({ updated: "2026-06-01" })),
    true,
  );
  assertEquals(
    evalExpr('updated > "2026-01-01"', ctx({ updated: "2025-06-01" })),
    false,
  );
});

Deno.test("isEmpty", () => {
  assertEquals(evalExpr("published.isEmpty()", ctx({ published: null })), true);
  assertEquals(
    evalExpr("published.isEmpty()", ctx({ published: "2026-01-01" })),
    false,
  );
});

Deno.test("unary ! negates postfix expressions", () => {
  const e = '!file.name.contains("Template")';
  assertEquals(evalExpr(e, ctx({})), true);
  assertEquals(evalExpr(e, ctx({}, { name: "Post Template" })), false);
  assertEquals(evalExpr("!!public", ctx({ public: "x" })), true);
});

Deno.test("&& and || with precedence (|| loosest, ! tightest)", () => {
  const c = ctx({ a: 1, b: 2, tags: ["daily"] });
  assertEquals(evalExpr("a == 1 && b == 2", c), true);
  assertEquals(evalExpr("a == 9 && b == 2", c), false);
  assertEquals(evalExpr("a == 9 || b == 2", c), true);
  // a==9 || (b==2 && missing) -> false || (true && false) -> false
  assertEquals(evalExpr("a == 9 || b == 2 && missing", c), false);
  assertEquals(evalExpr("(a == 9 || b == 2) && a == 1", c), true);
  assertEquals(evalExpr('!tags.contains("weekly") && a == 1', c), true);
});

Deno.test("bare properties use Obsidian truthiness", () => {
  assertEquals(evalExpr("public", ctx({ public: "my-slug" })), true);
  assertEquals(evalExpr("public", ctx({ public: true })), true);
  assertEquals(evalExpr("public", ctx({ public: "" })), false);
  assertEquals(evalExpr("public", ctx({ public: [] })), false);
  assertEquals(evalExpr("public", ctx({ public: false })), false);
  assertEquals(evalExpr("public", ctx({})), false);
});

Deno.test("file.hasTag matches frontmatter tags, # optional", () => {
  const c = ctx({ tags: ["Daily", "#log"] });
  assertEquals(evalExpr('file.hasTag("daily")', c), true);
  assertEquals(evalExpr('file.hasTag("#daily")', c), true);
  assertEquals(evalExpr('file.hasTag("log")', c), true);
  assertEquals(evalExpr('file.hasTag("weekly")', c), false);
  assertEquals(evalExpr('file.hasTag("weekly", "daily")', c), true);
  assertEquals(evalExpr('file.hasTag("daily")', ctx({})), false);
});

Deno.test("file.inFolder matches folder and subfolders", () => {
  const c = ctx({}, { relPath: "Posts/2026/Note.md" });
  assertEquals(evalExpr('file.inFolder("Posts")', c), true);
  assertEquals(evalExpr('file.inFolder("Posts/2026")', c), true);
  assertEquals(evalExpr('file.inFolder("Post")', c), false);
  assertEquals(evalExpr('file.inFolder("Other")', c), false);
  assertEquals(evalExpr('file.inFolder("Posts")', ctx({})), false);
});

Deno.test("file.hasLink matches normalized outgoing links", () => {
  const c = ctx({}, { links: ["posts", "research"] });
  assertEquals(evalExpr('file.hasLink(link("Posts"))', c), true);
  assertEquals(evalExpr('file.hasLink("[[Posts.base]]")', c), true);
  assertEquals(evalExpr('file.hasLink("Other")', c), false);
  assertEquals(evalExpr('file.hasLink("Posts")', ctx({})), false);
});

Deno.test("unsupported syntax throws (fails closed at caller)", () => {
  let threw = false;
  try {
    evalExpr("frobnicate(x)", ctx({}));
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
