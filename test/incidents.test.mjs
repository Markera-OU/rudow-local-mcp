import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { detectIncidents } from "../dist/incidents.js";
import { parseLine } from "../dist/parser.js";
import { LogStore } from "../dist/store.js";

const sampleLog = fileURLToPath(new URL("../examples/sample.log", import.meta.url));

function entriesFrom(lines, source = "app") {
  return lines.map((line, i) => parseLine(line, source, i));
}

function healthyLines(count, startMinute = 0) {
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    const minute = String(startMinute + Math.floor(i / 4)).padStart(2, "0");
    const second = String((i % 4) * 15).padStart(2, "0");
    lines.push(
      `{"timestamp":"2026-11-27T09:${minute}:${second}Z","level":"info","message":"GET /api/orders 200","status":200,"route":"/api/orders","method":"GET","latency_ms":50}`,
    );
  }
  return lines;
}

test("a quiet log produces no incidents", () => {
  const incidents = detectIncidents(entriesFrom(healthyLines(48)));
  assert.equal(incidents.length, 0);
});

test("an error spike after healthy traffic is detected", () => {
  const lines = [...healthyLines(40)];
  for (let i = 0; i < 30; i += 1) {
    const minute = String(20 + Math.floor(i / 4)).padStart(2, "0");
    const second = String((i % 4) * 15).padStart(2, "0");
    lines.push(
      `{"timestamp":"2026-11-27T09:${minute}:${second}Z","level":"error","message":"Database connection refused: host 10.0.4.21","status":500,"route":"/api/checkout","method":"POST","latency_ms":1500}`,
    );
  }
  const incidents = detectIncidents(entriesFrom(lines));
  assert.equal(incidents.length, 1);
  const incident = incidents[0];
  assert.equal(incident.status, "open");
  assert.ok(incident.signals.some((s) => s.signal === "error_rate_spike"));
  assert.ok(incident.signals.some((s) => s.signal === "new_error"));
  assert.match(incident.title, /Database connection refused/);
  assert.equal(incident.topErrors[0].count, 30);
  assert.ok(incident.timeline.length >= 3);
});

test("the sample log has a detected incident after the deploy marker", async () => {
  const store = new LogStore([{ name: "sample", path: sampleLog }]);
  store.load();
  const entries = store.allEntries();
  assert.ok(entries.length > 100, `sample log has ${entries.length} entries`);
  const incidents = detectIncidents(entries);
  assert.ok(incidents.length >= 1, "at least one incident is detected");
  const incident = incidents[0];
  assert.ok(incident.signals.some((s) => s.signal === "error_rate_spike"));
  assert.ok(incident.signals.some((s) => s.signal === "new_error"));
  assert.ok(
    incident.signals.some((s) => s.signal === "latency_rise"),
    "latency rise is a supporting signal",
  );
  assert.match(incident.topErrors[0].message, /ECONNREFUSED|checkout/i);
  // The spike starts after the 09:15 deploy marker.
  assert.ok(incident.startedAt >= "2026-11-27T09:15:00", incident.startedAt);
});

test("logs without timestamps produce no incidents", () => {
  const lines = Array.from({ length: 20 }, () => "some undated line without a timestamp");
  const incidents = detectIncidents(entriesFrom(lines));
  assert.equal(incidents.length, 0);
});

test("incidents are detected per source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rudow-local-test-"));
  const badPath = join(dir, "bad.log");
  const goodPath = join(dir, "good.log");
  const badLines = [...healthyLines(40)];
  for (let i = 0; i < 30; i += 1) {
    const minute = String(20 + Math.floor(i / 4)).padStart(2, "0");
    const second = String((i % 4) * 15).padStart(2, "0");
    badLines.push(
      `{"timestamp":"2026-11-27T09:${minute}:${second}Z","level":"error","message":"boom","status":500,"route":"/api/x","method":"GET","latency_ms":900}`,
    );
  }
  await writeFile(badPath, badLines.join("\n") + "\n", "utf-8");
  await writeFile(goodPath, healthyLines(48).join("\n") + "\n", "utf-8");
  const store = new LogStore([
    { name: "bad", path: badPath },
    { name: "good", path: goodPath },
  ]);
  store.load();
  const incidents = detectIncidents(store.allEntries());
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].source, "bad");
});
