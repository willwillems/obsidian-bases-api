import { assertEquals } from "jsr:@std/assert@^1";
import { isPublic, slugify } from "./indexer.ts";

Deno.test("isPublic: key must be present and not explicitly false", () => {
  assertEquals(isPublic({}), false); // no key -> private
  assertEquals(isPublic({ public: false }), false); // explicit opt-out
  assertEquals(isPublic({ public: null }), true); // bare `public:` key
  assertEquals(isPublic({ public: true }), true);
  assertEquals(isPublic({ public: "" }), true); // falls back to filename slug
  assertEquals(isPublic({ public: "my-slug" }), true);
});

Deno.test("slugify collapses non-alphanumerics and trims dashes", () => {
  assertEquals(slugify("Hello, World!"), "hello-world");
  assertEquals(slugify("  --Weird__Name--  "), "weird-name");
});
