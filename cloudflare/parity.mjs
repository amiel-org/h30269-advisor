import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildResult, roundTree } from "./worker.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

const target = readJson("cache/H30269.json");
const benchmark = readJson("cache/000985.json");
const dividend = readJson("cache/dividend_yield.json");
const bond = readJson("cache/bond_10y.json");
const expected = readJson("latest.json");
const generatedAt = new Date(`${expected.generated_at}+08:00`);
const actual = roundTree(buildResult(target, benchmark, dividend, bond, [], generatedAt).result);

assert.deepEqual(actual.metrics, expected.metrics, "Cloudflare metrics differ from Python metrics");
assert.deepEqual(actual.quality, expected.quality, "Cloudflare data quality differs from Python");
assert.deepEqual(actual.evaluation, expected.evaluation, "Cloudflare decision differs from Python");
assert.deepEqual(actual.position_advice, expected.position_advice, "Cloudflare position advice differs from Python");

console.log(`Parity check passed for ${expected.metrics.trade_date}: ${expected.evaluation.decision}`);
