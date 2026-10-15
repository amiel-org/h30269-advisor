// Pages Function: thin reverse proxy to the existing Worker.
//
// Why this exists: *.workers.dev is DNS-poisoned in mainland China, while
// *.pages.dev resolves to working Cloudflare edge IPs. The Worker keeps its KV
// data, scheduled trigger and all business logic; this file only forwards
// bytes. It contains no model maths and no secrets.
const UPSTREAM = "https://h30269-hs300.anyongliang027.workers.dev";

// Hop-by-hop and identity headers the edge owns. Forwarding them would make
// the upstream see the proxy's client metadata as if it were the real client.
const STRIP = new Set([
  "host", "connection", "keep-alive", "transfer-encoding", "upgrade",
  "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "cf-worker",
  "cf-ew-via", "cdn-loop", "x-forwarded-proto", "x-forwarded-for", "x-real-ip",
]);

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, UPSTREAM);

  const headers = new Headers(request.headers);
  for (const name of STRIP) headers.delete(name);

  const init = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;

  let response;
  try {
    response = await fetch(target.toString(), init);
  } catch (error) {
    // A proxy outage must be legible rather than a bare edge error page.
    return new Response(
      JSON.stringify({ ok: false, error: "代理到上游服务失败，请稍后重试", detail: String(error?.message || error) }),
      { status: 502, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } },
    );
  }

  const out = new Headers(response.headers);
  // The runtime decodes the body, so the original encoding/length no longer
  // describe it. Let the edge recompute both.
  out.delete("content-encoding");
  out.delete("content-length");
  out.delete("cf-cache-status");

  // Keep redirects on the address the browser actually opened, otherwise a
  // Location pointing at workers.dev would silently bounce the user back to
  // the unreachable host.
  const location = out.get("location");
  if (location) {
    if (location.startsWith(UPSTREAM)) out.set("location", location.slice(UPSTREAM.length) || "/");
    else if (location.startsWith("http://") || location.startsWith("https://")) {
      try {
        const parsed = new URL(location);
        if (parsed.hostname.endsWith(".workers.dev")) out.set("location", parsed.pathname + parsed.search + parsed.hash);
      } catch { /* leave malformed Location untouched */ }
    }
  }

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
}
