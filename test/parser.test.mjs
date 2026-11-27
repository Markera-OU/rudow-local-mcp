import assert from "node:assert/strict";
import { test } from "node:test";

import { detectFormat, parseLine } from "../dist/parser.js";

test("parses a JSON log line with all fields", () => {
  const entry = parseLine(
    '{"timestamp":"2026-11-27T09:00:00Z","level":"error","message":"checkout failed","status":500,"route":"/api/checkout","method":"POST","latency_ms":1234}',
    "app",
    0,
  );
  assert.equal(entry.format, "json");
  assert.equal(entry.parsed, true);
  assert.equal(entry.level, "error");
  assert.equal(entry.message, "checkout failed");
  assert.equal(entry.timestamp?.toISOString(), "2026-11-27T09:00:00.000Z");
  assert.equal(entry.status, 500);
  assert.equal(entry.route, "/api/checkout");
  assert.equal(entry.method, "POST");
  assert.equal(entry.latencyMs, 1234);
});

test("parses JSON lines with alternate field names", () => {
  const entry = parseLine(
    '{"time":"2026-11-27T09:00:00Z","severity":"WARN","msg":"slow query","duration_ms":812}',
    "app",
    0,
  );
  assert.equal(entry.level, "warn");
  assert.equal(entry.message, "slow query");
  assert.equal(entry.latencyMs, 812);
});

test("parses an Apache combined access line", () => {
  const entry = parseLine(
    '203.0.113.10 - - [27/Nov/2026:09:04:12 +0000] "GET /api/orders HTTP/1.1" 200 1842',
    "web",
    0,
  );
  assert.equal(entry.format, "access");
  assert.equal(entry.timestamp?.toISOString(), "2026-11-27T09:04:12.000Z");
  assert.equal(entry.level, "info");
  assert.equal(entry.status, 200);
  assert.equal(entry.route, "/api/orders");
  assert.equal(entry.method, "GET");
});

test("derives error level from a 500 access line", () => {
  const entry = parseLine(
    '203.0.113.10 - - [27/Nov/2026:09:04:12 +0000] "POST /api/checkout HTTP/1.1" 500 512',
    "web",
    0,
  );
  assert.equal(entry.level, "error");
  assert.equal(entry.status, 500);
});

test("parses plain text with an ISO timestamp and a level token", () => {
  const entry = parseLine(
    "2026-11-27T09:15:00Z ERROR Database connection refused: connect ECONNREFUSED 10.0.4.21:5432",
    "app",
    0,
  );
  assert.equal(entry.format, "text");
  assert.equal(entry.level, "error");
  assert.equal(entry.timestamp?.toISOString(), "2026-11-27T09:15:00.000Z");
  assert.match(entry.message, /Database connection refused/);
});

test("parses plain text with a date-time timestamp and a request", () => {
  const entry = parseLine(
    "2026-11-27 09:15:00 INFO GET /api/orders 200 in 42ms",
    "app",
    0,
  );
  assert.equal(entry.level, "info");
  assert.equal(entry.route, "/api/orders");
  assert.equal(entry.method, "GET");
  assert.equal(entry.latencyMs, 42);
});

test("keeps unparseable lines as searchable raw text", () => {
  const entry = parseLine("--- log rotated, previous file archived ---", "app", 0);
  assert.equal(entry.format, "unparsed");
  assert.equal(entry.parsed, false);
  assert.equal(entry.level, "unknown");
  assert.equal(entry.timestamp, null);
  assert.equal(entry.message, "--- log rotated, previous file archived ---");
});

test("detects the dominant format of a file", () => {
  const jsonLines = Array.from(
    { length: 5 },
    (_, i) => `{"timestamp":"2026-11-27T09:0${i}:00Z","level":"info","message":"ok"}`,
  );
  assert.equal(detectFormat(jsonLines), "json");
  const accessLines = Array.from(
    { length: 5 },
    () => '203.0.113.10 - - [27/Nov/2026:09:04:12 +0000] "GET /api/orders HTTP/1.1" 200 1842',
  );
  assert.equal(detectFormat(accessLines), "access");
});
