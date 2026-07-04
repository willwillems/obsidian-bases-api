import { assertEquals } from "jsr:@std/assert@^1";
import { app } from "./main.ts";

Deno.test("GET /api/openapi.json serves a 3.1 spec covering every route", async () => {
  const res = await app.request("/api/openapi.json");
  assertEquals(res.status, 200);
  const spec = await res.json();

  assertEquals(spec.openapi, "3.1.0");
  assertEquals(spec.info.title, "obsidian-bases-api");

  // Every documented path is present (OpenAPI uses {param} template syntax).
  const paths = Object.keys(spec.paths).sort();
  assertEquals(paths, [
    "/api",
    "/api/_health",
    "/api/assets/{name}",
    "/api/{base}",
    "/api/{base}/{id}",
  ]);

  // The read routes expose GET; the base collection also exposes POST (write).
  assertEquals(typeof spec.paths["/api"].get, "object");
  assertEquals(typeof spec.paths["/api/{base}"].get, "object");
  assertEquals(typeof spec.paths["/api/{base}"].post, "object");
  assertEquals(typeof spec.paths["/api/{base}/{id}"].get, "object");

  // POST is guarded by the Bearer security scheme.
  assertEquals(spec.paths["/api/{base}"].post.security, [{ Bearer: [] }]);
  assertEquals(spec.components.securitySchemes.Bearer.scheme, "bearer");
});
