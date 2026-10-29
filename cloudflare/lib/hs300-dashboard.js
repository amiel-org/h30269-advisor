// HS300 dashboard caching + history, on top of hs300-data.js.
//
// Mirrors the H30269 worker pattern: KV-cached dashboard payload, a force
// refresh path, and an appended history row per successful refresh.
import { buildHs300Result } from "./hs300-data.js";
import { DEFAULT_CONFIG } from "./hs300-model.js";
import { dashboardQuality } from "./hs300-decision.js";
import { quoteQuality } from "./hs300-live.js";

// Cache the full payload briefly. Daily history has its own longer-lived cache;
// a manual refresh obtains a new quote for the current analysis layer.
const CACHE_MS = 25 * 1000;
export const DASH_KEY = "hs300:dashboard:v5";
const HIST_KEY = "hs300:history";
const inFlight = new WeakMap();
export const SERVICE_VERSION = "v2.7.0";

function readableError(error) {
  return error?.name === "AbortError" || /abort|timeout/i.test(error?.message || "")
    ? "数据源响应超时，稍后会重新核验" : (error?.message || "数据源暂不可用");
}

function referencePayload(data, { now = new Date(), error = null, refreshing = false } = {}) {
  const warning = error || data.source_warning || data.refresh_error || null;
  const quality = dashboardQuality(data, now, warning);
  const analysis = data.analysis ? structuredClone(data.analysis) : null;
  if (analysis) {
    analysis.quote_quality = quoteQuality({ date: analysis.date, time: analysis.time, level: analysis.price }, now);
    const historical = analysis.quality.available && quality.analysis_available;
    analysis.quality = { ...analysis.quality, available: historical,
      can_decide: historical && analysis.quote_quality.can_decide && !warning && analysis.mode === "quote_estimate",
      reason: warning ? "本次核验未完成，保留上次报价分析" : analysis.quote_quality.reason };
  }
  return { ...data, analysis, service_version: SERVICE_VERSION, quality,
    refresh_status: refreshing ? "refreshing" : warning ? "reference" : "cached",
    refresh_error: warning, last_attempt_at: error ? now.toISOString() : data.last_attempt_at,
    refresh_pending: refreshing };
}

export async function kvGet(env, key) {
  if (!env.H30269_KV) return null;
  try {
    const raw = await env.H30269_KV.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function kvPut(env, key, value) {
  if (!env.H30269_KV) return;
  try { await env.H30269_KV.put(key, JSON.stringify(value)); } catch { /* ignore */ }
}

function historyRow(result) {
  return {
    as_of: result.as_of,
    pe: result.pe,
    pe_percentile: result.pe_percentile,
    erp_percentile: result.erp_percentile,
    target_exposure: result.target_exposure,
    price_000300: result.price_index?.level ?? null,
  };
}

async function loadHistory(env) {
  const rows = await kvGet(env, HIST_KEY);
  return Array.isArray(rows) ? rows : [];
}

async function saveHistory(env, result) {
  const rows = await loadHistory(env);
  const row = historyRow(result);
  const idx = rows.findIndex((r) => r.as_of === row.as_of);
  if (idx >= 0) rows[idx] = row; else rows.push(row);
  rows.sort((a, b) => (a.as_of < b.as_of ? -1 : 1));
  await kvPut(env, HIST_KEY, rows.slice(-400));
}

export async function refreshHs300(env, { recordHistory = true, builder = buildHs300Result, timeoutMs = 22000, forceCheck = false } = {}) {
  const controller = new AbortController();
  let timer;
  let result;
  try {
    result = await Promise.race([
      builder(env, { signal: controller.signal, forceCheck }),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new Error("数据源响应超时，请稍后重试"));
      }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
  if (recordHistory) await saveHistory(env, result);
  const payload = { ...result, history: await loadHistory(env), server_time: new Date().toISOString(),
    service_version: SERVICE_VERSION, refresh_status: result.source_warning ? "reference" : "fresh",
    refresh_error: result.source_warning || null, refresh_pending: false };
  await kvPut(env, DASH_KEY, { cached_at: new Date().toISOString(), data: payload });
  return payload;
}

export async function getHs300Dashboard(env, force = false, options = {}) {
  const cached = await kvGet(env, DASH_KEY) || await kvGet(env, "hs300:dashboard:v4");
  const age = cached?.cached_at ? Date.now() - Date.parse(cached.cached_at) : Number.POSITIVE_INFINITY;
  const valid = cached?.data?.model_version === DEFAULT_CONFIG.version;
  if (!force && valid && cached.data.analysis && age >= 0 && age < CACHE_MS) {
    return { ...referencePayload(cached.data), cache_age_seconds: Math.floor(age / 1000) };
  }
  let pending = inFlight.get(env);
  if (!pending) {
    pending = refreshHs300(env, { ...options, forceCheck: force, recordHistory: true });
    inFlight.set(env, pending);
  }
  const settled = pending.catch(async (error) => {
    if (!valid) throw error;
    const now = new Date();
    const payload = referencePayload(cached.data, { now, error: readableError(error) });
    // Persist the failed attempt time too: subsequent visits serve a dated
    // reference immediately and do not hammer the unavailable upstream.
    await kvPut(env, DASH_KEY, { cached_at: now.toISOString(), data: payload });
    return payload;
  }).finally(() => {
    if (inFlight.get(env) === pending) inFlight.delete(env);
  });
  if (!force && valid && cached.data.analysis && options.ctx) {
    options.ctx.waitUntil(settled.catch(() => {}));
    return referencePayload(cached.data, { refreshing: true });
  }
  return await settled;
}
