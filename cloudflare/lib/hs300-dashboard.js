// HS300 dashboard caching + history, on top of hs300-data.js.
//
// Mirrors the H30269 worker pattern: KV-cached dashboard payload, a force
// refresh path, and an appended history row per successful refresh.
import { buildHs300Result } from "./hs300-data.js";

// The underlying data is DAILY frequency: intraday re-fetching buys nothing and
// makes a cold cache more likely.  30 minutes keeps manual refresh responsive
// while the daily cron pre-warms the cache.
const CACHE_MS = 30 * 60 * 1000;
const DASH_KEY = "hs300:dashboard:latest";
const HIST_KEY = "hs300:history";

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
  return (await kvGet(env, HIST_KEY)) || [];
}

async function saveHistory(env, result) {
  const rows = await loadHistory(env);
  const row = historyRow(result);
  const idx = rows.findIndex((r) => r.as_of === row.as_of);
  if (idx >= 0) rows[idx] = row; else rows.push(row);
  rows.sort((a, b) => (a.as_of < b.as_of ? -1 : 1));
  await kvPut(env, HIST_KEY, rows.slice(-400));
}

export async function refreshHs300(env, { recordHistory = true } = {}) {
  const result = await buildHs300Result();
  const payload = { ...result, history: await loadHistory(env), server_time: new Date().toISOString() };
  await kvPut(env, DASH_KEY, { cached_at: new Date().toISOString(), data: payload });
  if (recordHistory) await saveHistory(env, result);
  return payload;
}

export async function getHs300Dashboard(env, force = false) {
  const cached = await kvGet(env, DASH_KEY);
  const age = cached?.cached_at ? Date.now() - Date.parse(cached.cached_at) : Number.POSITIVE_INFINITY;
  if (!force && cached?.data && age < CACHE_MS) return cached.data;
  try {
    return await refreshHs300(env, { recordHistory: force });
  } catch (error) {
    if (cached?.data) return cached.data;
    throw error;
  }
}
