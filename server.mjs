import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.join(APP_DIR, "cloudflare-dist");
const DATA_DIR = process.env.DATA_DIR || path.join(APP_DIR, "data");
const KV_FILE = path.join(DATA_DIR, "kv.json");
const PORT = Number(process.env.PORT || 8789);
const HOST = process.env.HOST || "0.0.0.0";
const TIME_ZONE = process.env.TIME_ZONE || "Asia/Shanghai";
const REFRESH_MINUTE = Number(process.env.REFRESH_MINUTE || 0);
const REFRESH_HOURS = new Set(
  (process.env.REFRESH_HOURS || "10,11,12,13,14,15")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 23),
);
const RUN_ON_START = /^(1|true|yes)$/i.test(process.env.RUN_ON_START || "true");

const worker = (await import("./cloudflare/worker.js")).default;

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const WEEKDAYS = new Map([
  ["Sun", 0], ["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6],
]);

function timeParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday: WEEKDAYS.get(values.weekday) ?? -1,
  };
}

function localDay(parts) {
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function scheduledSlot(parts) {
  return `${localDay(parts)}T${String(parts.hour).padStart(2, "0")}:${String(REFRESH_MINUTE).padStart(2, "0")}`;
}

function isScheduledSlot(parts) {
  return parts.weekday >= 1 && parts.weekday <= 5
    && REFRESH_HOURS.has(parts.hour)
    && parts.minute === REFRESH_MINUTE;
}

await fs.mkdir(DATA_DIR, { recursive: true });
let kvStore = new Map();
try {
  const raw = await fs.readFile(KV_FILE, "utf8");
  kvStore = new Map(Object.entries(JSON.parse(raw)));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

let writeChain = Promise.resolve();
function persistKv() {
  const snapshot = JSON.stringify(Object.fromEntries(kvStore));
  writeChain = writeChain.then(async () => {
    const temporary = `${KV_FILE}.tmp`;
    await fs.writeFile(temporary, snapshot, "utf8");
    await fs.rename(temporary, KV_FILE);
  });
  return writeChain;
}

const kv = {
  async get(key, options = {}) {
    const value = kvStore.get(key) ?? null;
    if (value === null) return null;
    return options?.type === "json" ? JSON.parse(value) : value;
  },
  async put(key, value) {
    kvStore.set(key, String(value));
    await persistKv();
  },
};

async function assetFetch(request) {
  if (!["GET", "HEAD"].includes(request.method)) return new Response("Method Not Allowed", { status: 405 });
  const url = new URL(request.url);
  let relative = decodeURIComponent(url.pathname);
  if (relative === "/" || relative === "") relative = "/index.html";
  else if (relative === "/hs300" || relative === "/hs300/") relative = "/hs300.html";
  const target = path.resolve(ASSET_DIR, `.${relative}`);
  if (target !== ASSET_DIR && !target.startsWith(`${ASSET_DIR}${path.sep}`)) {
    return new Response("Forbidden", { status: 403 });
  }
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) return new Response("Not Found", { status: 404 });
    const body = await fs.readFile(target);
    const headers = {
      "Content-Type": MIME.get(path.extname(target).toLowerCase()) || "application/octet-stream",
      "Content-Length": String(body.length),
      "Cache-Control": target.includes(`${path.sep}vendor${path.sep}`) ? "public, max-age=86400" : "no-cache",
      "X-Content-Type-Options": "nosniff",
    };
    return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
  } catch (error) {
    if (error.code === "ENOENT") return new Response("Not Found", { status: 404 });
    throw error;
  }
}

const env = { H30269_KV: kv, ASSETS: { fetch: assetFetch } };

function requestContext() {
  return {
    waitUntil(promise) {
      Promise.resolve(promise).catch((error) => console.error("[background]", error));
    },
    passThroughOnException() {},
  };
}

async function readBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

let lastScheduledSlot = "";
let scheduledRunning = false;
let lastScheduledCompletedAt = null;

async function runScheduled(reason = "manual") {
  if (scheduledRunning) {
    console.log(`[scheduled] skip overlapping run (${reason})`);
    return;
  }
  scheduledRunning = true;
  const started = Date.now();
  console.log(`[scheduled] start (${reason})`);
  try {
    const pending = [];
    const context = {
      waitUntil(promise) { pending.push(Promise.resolve(promise)); },
      passThroughOnException() {},
    };
    await worker.scheduled({ scheduledTime: Date.now(), cron: "0 10-15 * * 1-5" }, env, context);
    const results = await Promise.allSettled(pending);
    for (const result of results) if (result.status === "rejected") console.error("[scheduled]", result.reason);
    lastScheduledCompletedAt = new Date().toISOString();
    console.log(`[scheduled] complete (${reason}) ${Date.now() - started}ms`);
  } finally {
    scheduledRunning = false;
  }
}

const server = http.createServer(async (request, response) => {
  const started = Date.now();
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || `127.0.0.1:${PORT}`}`);
    if (url.pathname === "/__local/status") {
      const parts = timeParts();
      const payload = {
        ok: true,
        runtime: "docker-node",
        time: new Date().toISOString(),
        schedule: {
          timezone: TIME_ZONE,
          weekdays: "Mon-Fri",
          hours: [...REFRESH_HOURS].sort((a, b) => a - b),
          minute: REFRESH_MINUTE,
          run_on_start: RUN_ON_START,
          last_scheduled_slot: lastScheduledSlot,
          last_completed_at: lastScheduledCompletedAt,
        },
        data_file: KV_FILE,
        server_time: `${localDay(parts)} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")} ${TIME_ZONE}`,
      };
      const body = Buffer.from(JSON.stringify(payload));
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(body.length), "Cache-Control": "no-store" });
      response.end(body);
      return;
    }

    const protocol = request.headers["x-forwarded-proto"] || "http";
    const host = request.headers.host || `127.0.0.1:${PORT}`;
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
      else if (value !== undefined) headers.set(name, value);
    }
    const body = await readBody(request);
    const workerRequest = new Request(`${protocol}://${host}${request.url}`, {
      method: request.method,
      headers,
      body,
    });
    const workerResponse = await worker.fetch(workerRequest, env, requestContext());
    response.statusCode = workerResponse.status;
    workerResponse.headers.forEach((value, name) => response.setHeader(name, value));
    const payload = Buffer.from(await workerResponse.arrayBuffer());
    response.end(payload);
    console.log(`${request.method} ${request.url} ${workerResponse.status} ${Date.now() - started}ms`);
  } catch (error) {
    console.error(`${request.method} ${request.url} failed`, error);
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
  }
});

server.on("clientError", (_error, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

const scheduleTimer = setInterval(() => {
  const parts = timeParts();
  if (!isScheduledSlot(parts)) return;
  const slot = scheduledSlot(parts);
  if (lastScheduledSlot === slot) return;
  lastScheduledSlot = slot;
  runScheduled(`schedule ${slot}`).catch((error) => console.error("[scheduled] failed", error));
}, 15000);

server.listen(PORT, HOST, () => {
  console.log(`H30269 local dashboard listening on http://${HOST}:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Scheduled refresh: Mon-Fri ${[...REFRESH_HOURS].sort((a, b) => a - b).map((hour) => `${String(hour).padStart(2, "0")}:${String(REFRESH_MINUTE).padStart(2, "0")}`).join(", ")} ${TIME_ZONE}`);
  if (RUN_ON_START) {
    const parts = timeParts();
    lastScheduledSlot = scheduledSlot(parts);
    setTimeout(() => runScheduled("startup").catch((error) => console.error("[scheduled] startup failed", error)), 1500);
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearInterval(scheduleTimer);
    server.close(async () => {
      await writeChain.catch(() => {});
      process.exit(0);
    });
  });
}