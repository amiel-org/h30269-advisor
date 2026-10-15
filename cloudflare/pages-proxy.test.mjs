import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// The real entry file is literally named "[[path]].js" (a Pages catch-all).
// Brackets are glob metacharacters, so copy it to a plain name outside the
// repository before importing.
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "pages-proxy", "functions", "[[path]].js"), "utf8");
const tmpFile = join(tmpdir(), `hs300-pages-proxy-${process.pid}.mjs`);
writeFileSync(tmpFile, source, "utf8");
const { onRequest } = await import(`file://${tmpFile.replaceAll("\\", "/")}`);

const UPSTREAM = "https://h30269-hs300.anyongliang027.workers.dev";

function call(path, { method = "GET", headers = {}, body } = {}) {
  const request = new Request(`https://desk.pages.dev${path}`, { method, headers, body });
  return onRequest({ request });
}

test("forwards method, path and query to the upstream worker", async (t) => {
  let seen;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    seen = { url: String(url), method: init.method };
    return new Response("ok", { status: 200 });
  });
  const res = await call("/api/hs300/refresh?a=1", { method: "POST", body: "{}" });
  assert.equal(res.status, 200);
  assert.equal(seen.url, `${UPSTREAM}/api/hs300/refresh?a=1`);
  assert.equal(seen.method, "POST");
});

test("rewrites worker-domain redirects so the browser stays on pages.dev", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(null, { status: 302, headers: { location: `${UPSTREAM}/hs300` } }));
  const res = await call("/hs300");
  assert.equal(res.headers.get("location"), "/hs300");
});

test("drops hop-by-hop and client-identity headers before forwarding", async (t) => {
  let sent;
  t.mock.method(globalThis, "fetch", async (_u, init) => { sent = init.headers; return new Response("ok"); });
  await call("/", { headers: {
    host: "desk.pages.dev", "cf-connecting-ip": "1.2.3.4",
    "x-forwarded-for": "1.2.3.4", "x-custom": "keep",
  } });
  assert.equal(sent.get("cf-connecting-ip"), null);
  assert.equal(sent.get("x-forwarded-for"), null);
  assert.equal(sent.get("x-custom"), "keep");
});

test("recomputes body headers after the runtime decodes the response", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response("hello", { status: 200, headers: { "content-encoding": "gzip", "content-length": "999" } }));
  const res = await call("/");
  assert.equal(res.headers.get("content-encoding"), null);
  assert.equal(res.headers.get("content-length"), null);
  assert.equal(await res.text(), "hello");
});

test("upstream failure becomes a legible 502 instead of a blank edge error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("edge unreachable"); });
  const res = await call("/api/hs300/dashboard");
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.detail, /edge unreachable/);
});

test("204 and HEAD pass through without a body", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
  assert.equal((await call("/favicon.ico")).status, 204);
  assert.equal((await call("/api/hs300/health", { method: "HEAD" })).status, 204);
});

test("external redirects are preserved; worker redirects are relativised", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(null, { status: 301, headers: { location: "https://example.com/x" } }));
  const res = await call("/old");
  assert.equal(res.headers.get("location"), "https://example.com/x");
});
