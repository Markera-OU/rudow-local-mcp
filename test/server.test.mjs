import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const sampleLog = fileURLToPath(new URL("../examples/sample.log", import.meta.url));

async function connect() {
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, RUDOW_LOCAL_LOG_PATHS: sampleLog },
    stderr: "ignore",
  });
  await client.connect(transport);
  return client;
}

function text(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}

test("lists the local tools", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 14);
  for (const name of [
    "list_sources",
    "query_logs",
    "query_logs_batched",
    "aggregate_logs",
    "metrics_summary",
    "metrics_overview",
    "metrics_trends",
    "metrics_distributions",
    "metrics_routes",
    "metrics_levels",
    "route_drilldown",
    "fetch_window",
    "list_incidents",
    "get_incident",
  ]) {
    assert.ok(tools.some((t) => t.name === name), `${name} is listed`);
  }
  assert.ok(!tools.some((t) => t.name === "semantic_search"), "no semantic search");
  assert.ok(!tools.some((t) => t.name === "create_project"), "no hosted setup tools");
  for (const tool of tools) {
    assert.ok(tool.description, `${tool.name} has a description`);
    assert.equal(tool.inputSchema.type, "object");
  }
  await client.close();
});

test("list_sources reports the sample log", async () => {
  const client = await connect();
  const data = text(await client.callTool({ name: "list_sources", arguments: {} }));
  assert.equal(data.sources.length, 1);
  assert.equal(data.sources[0].name, "sample");
  assert.ok(data.sources[0].entries > 100);
  assert.equal(data.sources[0].firstTimestamp, "2026-11-27T09:00:00.000Z");
  await client.close();
});

test("query_logs returns real error lines, newest first", async () => {
  const client = await connect();
  const data = text(
    await client.callTool({ name: "query_logs", arguments: { level: "error", limit: 5 } }),
  );
  assert.equal(data.returned, 5);
  assert.ok(data.totalMatching > 50);
  assert.ok(data.entries.every((e) => e.level === "error"));
  assert.match(data.entries[0].message, /ECONNREFUSED|checkout/);
  const times = data.entries.map((e) => e.timestamp);
  assert.deepEqual(times, [...times].sort().reverse());
  await client.close();
});

test("aggregate_logs groups by level and route", async () => {
  const client = await connect();
  const byLevel = text(
    await client.callTool({ name: "aggregate_logs", arguments: { group_by: "level" } }),
  );
  const errorGroup = byLevel.groups.find((g) => g.key === "error");
  assert.ok(errorGroup.count > 50);
  assert.equal(byLevel.total, byLevel.groups.reduce((a, g) => a + g.count, 0));
  const byRoute = text(
    await client.callTool({ name: "aggregate_logs", arguments: { group_by: "route" } }),
  );
  assert.ok(byRoute.groups.some((g) => g.key === "/api/checkout"));
  await client.close();
});

test("metrics_summary reports volume, error rate and latency", async () => {
  const client = await connect();
  const data = text(await client.callTool({ name: "metrics_summary", arguments: {} }));
  assert.ok(data.totalEntries > 100);
  assert.ok(data.errorRate > 0.3 && data.errorRate < 0.5);
  assert.ok(data.latency.p95Ms > 1000);
  assert.equal(data.topRoutes[0].route, "/api/checkout");
  assert.match(data.topErrors[0].message, /ECONNREFUSED/);
  await client.close();
});

test("metrics_levels, metrics_routes and route_drilldown agree", async () => {
  const client = await connect();
  const levels = text(await client.callTool({ name: "metrics_levels", arguments: {} }));
  assert.ok(levels.levels.some((l) => l.level === "error" && l.count > 50));
  const routes = text(await client.callTool({ name: "metrics_routes", arguments: {} }));
  const checkout = routes.routes.find((r) => r.route === "/api/checkout");
  assert.ok(checkout.requests > 40);
  assert.ok(checkout.errorRate > 0.8);
  const drill = text(
    await client.callTool({
      name: "route_drilldown",
      arguments: { route: "/api/checkout" },
    }),
  );
  assert.equal(drill.requests, checkout.requests);
  assert.equal(drill.errorsByStatus["500"], checkout.errors);
  await client.close();
});

test("list_incidents finds the spike and get_incident explains it", async () => {
  const client = await connect();
  const listed = text(await client.callTool({ name: "list_incidents", arguments: {} }));
  assert.ok(listed.incidents.length >= 1);
  const incident = listed.incidents[0];
  assert.equal(incident.status, "open");
  assert.ok(incident.signals.some((s) => s.signal === "error_rate_spike"));
  const detail = text(
    await client.callTool({
      name: "get_incident",
      arguments: { incident_id: incident.id },
    }),
  );
  assert.equal(detail.id, incident.id);
  assert.ok(detail.topErrors.length > 0);
  assert.ok(detail.timeline.length >= 3);
  assert.match(detail.topErrors[0].message, /ECONNREFUSED/);
  await client.close();
});

test("fetch_window returns entries around the deploy", async () => {
  const client = await connect();
  const data = text(
    await client.callTool({
      name: "fetch_window",
      arguments: { around_iso: "2026-11-27T09:15:00Z", n: 3 },
    }),
  );
  assert.equal(data.before.length, 3);
  assert.equal(data.after.length, 4);
  assert.ok(
    [...data.before, ...data.after].some((e) => e.message.includes("Deploy v1.4.2")),
  );
  await client.close();
});

test("unknown tool and unknown source are rejected with a clear error", async () => {
  const client = await connect();
  const unknown = await client.callTool({ name: "drop_database", arguments: {} });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Unknown tool/);
  const badSource = await client.callTool({
    name: "query_logs",
    arguments: { source: "nope" },
  });
  assert.equal(badSource.isError, true);
  assert.match(badSource.content[0].text, /Unknown source/);
  await client.close();
});
