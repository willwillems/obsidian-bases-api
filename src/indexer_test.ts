import { assertEquals } from "jsr:@std/assert@^1";
import { isPublic, referencedAssets } from "./indexer.ts";

Deno.test("isPublic: only a non-empty string slug publishes a note", () => {
  assertEquals(isPublic({}), false); // no key -> private
  assertEquals(isPublic({ public: false }), false); // explicit opt-out
  assertEquals(isPublic({ public: null }), false); // bare `public:` key
  assertEquals(isPublic({ public: true }), false); // no slug -> private
  assertEquals(isPublic({ public: "" }), false); // empty value -> private
  assertEquals(isPublic({ public: "   " }), false); // whitespace-only -> private
  assertEquals(isPublic({ public: 42 }), false); // non-string -> private
  assertEquals(isPublic({ public: "my-slug" }), true);
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
