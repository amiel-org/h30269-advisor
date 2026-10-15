// HS300 dashboard caching + history, on top of hs300-data.js.
//
// Mirrors the H30269 worker pattern: KV-cached dashboard payload, a force
// refresh path, and an appended history row per successful refresh.
import { buildHs300Result } from "./hs300-data.js";
import { DEFAULT_CONFIG } from "./hs300-model.js";
import { dataQuality } from "./hs300-decision.js";

// Cache the full payload briefly. Daily history has its own longer-lived cache;
// a manual refresh obtains a new observation-only quote.
const CACHE_MS = 5 * 60 * 1000;
export const DASH_KEY = "hs300:dashboard:v4";
const HIST_KEY = "hs300:history";
const inFlight = new WeakMap();

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

export async function refreshHs300(env, { recordHistory = true, builder = buildHs300Result, timeoutMs = 24000 } = {}) {
  const controller = new AbortController();
  let timer;
  let result;
  try {
    result = await Promise.race([
      builder(env, { signal: controller.signal }),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new Error("数据源响应超时，请稍后重试"));
      }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
  if (recordHistory) await saveHistory(env, result);
  const payload = { ...result, history: await loadHistory(env), server_time: new Date().toISOString(),
    refresh_status: "fresh", refresh_error: null };
  await kvPut(env, DASH_KEY, { cached_at: new Date().toISOString(), data: payload });
  return payload;
}

export async function getHs300Dashboard(env, force = false, options = {}) {
  const cached = await kvGet(env, DASH_KEY);
  const age = cached?.cached_at ? Date.now() - Date.parse(cached.cached_at) : Number.POSITIVE_INFINITY;
  const valid = cached?.data?.model_version === DEFAULT_CONFIG.version;
  if (!force && valid && age >= 0 && age < CACHE_MS) {
    const quality = dataQuality({ dates: [cached.data.price_asof] }, cached.data.bond?.as_of);
    return { ...cached.data, quality, refresh_status: "cached", cache_age_seconds: Math.floor(age / 1000) };
  }
  let pending = inFlight.get(env);
  if (!pending) {
    pending = refreshHs300(env, { ...options, recordHistory: true });
    inFlight.set(env, pending);
  }
  try {
    return await pending;
  } catch (error) {
    if (valid) return { ...cached.data,
      refresh_status: "stale", refresh_error: error.message,
      cache_age_seconds: Math.max(0, Math.floor(age / 1000)),
      quality: { ...cached.data.quality, actionable: false,
        blockers: ["本次刷新失败，正在展示旧快照，暂停交易提示"] } };
    throw error;
  } finally {
    if (inFlight.get(env) === pending) inFlight.delete(env);
  }
}
