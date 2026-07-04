import { assertEquals } from "jsr:@std/assert@^1";
import { isPublic, referencedAssets, slugify } from "./indexer.ts";

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

Deno.test("referencedAssets: body embeds, skipping note transclusions", () => {
  const body = "![[IMG_1.jpeg]] ![[Some Note]] ![[Other.md]] [[not-embed.png]]";
  assertEquals(referencedAssets(body, {}), ["IMG_1.jpeg"]);
});

Deno.test("referencedAssets: wikilinks in frontmatter values", () => {
  const fm = {
    cover: "[[photo.png]]",
    gallery: ["![[a.jpg|thumb]]", "[[assets/b.pdf#page=2]]"],
    nested: { icon: "[[icon.svg]]" },
    related: "[[Another Note]]", // note link, not an asset
    plain: "loose-string.png", // no wikilink syntax -> ignored
  };
  assertEquals(
    referencedAssets("", fm).sort(),
    ["a.jpg", "b.pdf", "icon.svg", "photo.png"],
  );
});
