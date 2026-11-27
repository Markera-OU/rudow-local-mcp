import assert from "node:assert/strict";
import { test } from "node:test";

import { detectIncidents } from "../dist/incidents.js";
import { parseLine } from "../dist/parser.js";

// Regression tests for the incident-detection baseline bug, reproduced
// from the live dummy-app run (2026-11-27): a sustained multi-bucket
// DB error spike was understated because the baseline median included
// the firing buckets themselves. The first detection covered only the
// last minute of a 2.5-minute spike, new_error never fired for a
// first-seen ECONNREFUSED, latency_rise was absent despite p95
// 3825 ms against a ~120 ms baseline, and the incident window moved
// when more log lines arrived.

const BASE = Date.parse("2026-11-27T09:00:00Z");

function at(offsetSeconds) {
  return new Date(BASE + offsetSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function entriesFrom(lines, source = "checkout-app") {
  return lines.map((line, i) => parseLine(line, source, i));
}

function cleanLine(offsetSeconds) {
  return JSON.stringify({
    timestamp: at(offsetSeconds),
    level: "info",
    message: "GET /api/products 200",
    status: 200,
    route: "/api/products",
    method: "GET",
    latency_ms: 50 + (offsetSeconds % 8) * 10,
  });
}

function errorLine(offsetSeconds, k) {
  return JSON.stringify({
    timestamp: at(offsetSeconds),
    level: "error",
    message: "POST /api/checkout 500 ECONNREFUSED: connect to db-primary:5432",
    status: 500,
    route: "/api/checkout",
    method: "POST",
    latency_ms: 1800 + (k % 13) * 200,
  });
}

function bucketLines(bucketStart, count, errors) {
  const lines = [];
  for (let k = 0; k < count; k += 1) {
    const offset = bucketStart + Math.floor((k * 60) / count);
    lines.push(k < errors ? errorLine(offset, k) : cleanLine(offset));
  }
  return lines;
}

// Mirror the dummy-app log: one clean minute, three spike minutes
// (rates 0.34 / 0.65 / 0.56), one clean minute.
function dummyScenarioLines() {
  return [
    ...bucketLines(0, 60, 0), // B0 clean, rate 0.00
    ...bucketLines(60, 70, 24), // B1 spike, rate 0.34
    ...bucketLines(120, 75, 49), // B2 spike, rate 0.65
    ...bucketLines(180, 52, 29), // B3 spike, rate 0.56
    ...bucketLines(240, 21, 0), // B4 clean, rate 0.00
  ];
}

test("a sustained multi-bucket spike is detected from its first firing bucket", () => {
  const incidents = detectIncidents(entriesFrom(dummyScenarioLines()));
  assert.equal(incidents.length, 1);
  const incident = incidents[0];
  // The spike starts in the 09:01 bucket; the old baseline masked it.
  assert.ok(
    incident.startedAt.startsWith("2026-11-27T09:01:"),
    `incident starts at ${incident.startedAt}, expected 09:01`,
  );
  assert.ok(
    incident.endedAt.startsWith("2026-11-27T09:04:"),
    `incident ends at ${incident.endedAt}, expected 09:04`,
  );
  assert.equal(incident.entryCount, 70 + 75 + 52);
  // The baseline must stay near the true pre-spike rate (0), not the
  // median inflated by the spike buckets (~0.17 in the old code).
  const spike = incident.signals.find((s) => s.signal === "error_rate_spike");
  assert.ok(spike, "error_rate_spike signal is present");
  assert.ok(
    spike.usual <= 0.05,
    `baseline error rate is ${spike.usual}, expected near 0`,
  );
  // ECONNREFUSED first appears inside the incident window.
  assert.ok(
    incident.signals.some((s) => s.signal === "new_error"),
    "new_error fires for the first-seen ECONNREFUSED",
  );
  // p95 jumps from ~120 ms clean to ~4000 ms in the spike.
  const latency = incident.signals.find((s) => s.signal === "latency_rise");
  assert.ok(latency, "latency_rise fires on the p95 jump");
  assert.ok(latency.usual <= 250, `baseline p95 is ${latency.usual}, expected near 120`);
  assert.ok(latency.observed >= 2000, `observed p95 is ${latency.observed}`);
  assert.match(incident.topErrors[0].message, /ECONNREFUSED/);
});

test("the incident window does not move as clean traffic is appended", () => {
  const first = detectIncidents(entriesFrom(dummyScenarioLines()));
  assert.equal(first.length, 1);
  const withTail = [
    ...dummyScenarioLines(),
    ...bucketLines(300, 21, 0), // one more clean minute, 09:05
  ];
  const second = detectIncidents(entriesFrom(withTail));
  assert.equal(second.length, 1);
  assert.equal(
    second[0].startedAt,
    first[0].startedAt,
    "appending clean log lines must not shift the incident start",
  );
  assert.equal(second[0].endedAt, first[0].endedAt);
});
