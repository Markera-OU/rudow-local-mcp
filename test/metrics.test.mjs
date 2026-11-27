import assert from "node:assert/strict";
import { test } from "node:test";

import { LogStore } from "../dist/store.js";
import {
  errorRate,
  latencyStats,
  levelCounts,
  normalizeMessage,
  routeStats,
  statusCounts,
  topErrors,
} from "../dist/metrics.js";
import { parseLine } from "../dist/parser.js";

function entriesFrom(lines, source = "app") {
  return lines.map((line, i) => parseLine(line, source, i));
}

const LINES = [
  '{"timestamp":"2026-11-27T09:00:00Z","level":"info","message":"GET /api/orders 200","status":200,"route":"/api/orders","method":"GET","latency_ms":40}',
  '{"timestamp":"2026-11-27T09:01:00Z","level":"info","message":"GET /api/orders 200","status":200,"route":"/api/orders","method":"GET","latency_ms":60}',
  '{"timestamp":"2026-11-27T09:02:00Z","level":"info","message":"GET /api/products 200","status":200,"route":"/api/products","method":"GET","latency_ms":80}',
  '{"timestamp":"2026-11-27T09:03:00Z","level":"error","message":"Database connection refused: host 10.0.4.21","status":500,"route":"/api/checkout","method":"POST","latency_ms":1200}',
  '{"timestamp":"2026-11-27T09:04:00Z","level":"error","message":"Database connection refused: host 10.0.4.22","status":500,"route":"/api/checkout","method":"POST","latency_ms":1400}',
  '{"timestamp":"2026-11-27T09:05:00Z","level":"warn","message":"GET /api/orders 404","status":404,"route":"/api/orders","method":"GET","latency_ms":30}',
];

test("level counts group entries by level", () => {
  const counts = levelCounts(entriesFrom(LINES));
  assert.equal(counts.info, 3);
  assert.equal(counts.error, 2);
  assert.equal(counts.warn, 1);
});

test("status counts group entries by status code", () => {
  const counts = statusCounts(entriesFrom(LINES));
  assert.equal(counts["200"], 3);
  assert.equal(counts["500"], 2);
  assert.equal(counts["404"], 1);
});

test("error rate is the share of error and fatal entries", () => {
  assert.equal(errorRate(entriesFrom(LINES)), 2 / 6);
  assert.equal(errorRate([]), 0);
});

test("latency percentiles cover the parsed values", () => {
  const stats = latencyStats(entriesFrom(LINES));
  assert.equal(stats.count, 6);
  assert.equal(stats.p50Ms, 70);
  assert.equal(stats.p95Ms, 1350);
  assert.equal(stats.p99Ms, 1390);
});

test("latency stats report no data when nothing carries latency", () => {
  const stats = latencyStats(entriesFrom(['2026-11-27T09:00:00Z INFO hello']));
  assert.equal(stats.count, 0);
  assert.equal(stats.p95Ms, null);
});

test("route stats rank by volume and carry error rates", () => {
  const routes = routeStats(entriesFrom(LINES));
  assert.equal(routes[0].route, "/api/orders");
  assert.equal(routes[0].requests, 3);
  const checkout = routes.find((r) => r.route === "/api/checkout");
  assert.equal(checkout.requests, 2);
  assert.equal(checkout.errors, 2);
  assert.equal(checkout.errorRate, 1);
  assert.equal(checkout.p95LatencyMs, 1390);
});

test("error groups collapse ids and numbers in messages", () => {
  assert.equal(
    normalizeMessage("Database connection refused: host 10.0.4.21"),
    "Database connection refused: host <n>.<n>.<n>.<n>",
  );
  const groups = topErrors(entriesFrom(LINES));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 2);
});

test("store loads a file and filters by level, text and source", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "rudow-local-test-"));
  const path = join(dir, "app.log");
  await writeFile(path, LINES.join("\n") + "\n", "utf-8");
  const store = new LogStore([{ name: "app", path }]);
  store.load();
  assert.equal(store.allEntries().length, 6);
  assert.equal(store.filter({ level: "error" }).length, 2);
  assert.equal(store.filter({ text: "connection refused" }).length, 2);
  assert.equal(store.filter({ source: "other" }).length, 0);
  assert.equal(store.filter({ source: "app" }).length, 6);
  const sources = store.listSources();
  assert.equal(sources[0].name, "app");
  assert.equal(sources[0].entries, 6);
  assert.equal(sources[0].format, "json");
  assert.equal(sources[0].firstTimestamp, "2026-11-27T09:00:00.000Z");
  assert.equal(sources[0].lastTimestamp, "2026-11-27T09:05:00.000Z");
});
