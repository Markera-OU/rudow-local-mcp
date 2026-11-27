// Tool handlers: each tool name maps to a function of its arguments
// and the loaded log store, returning a plain JSON-able value that the
// server serialises as the tool result.

import { detectIncidents } from "./incidents.js";
import {
  errorRate,
  latencyHistogram,
  latencyStats,
  levelCounts,
  round,
  routeStats,
  statusCounts,
  topErrors,
  trends,
} from "./metrics.js";
import type { LogEntry } from "./parser.js";
import type { LogStore } from "./store.js";
import { TOOLS } from "./tools.js";

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

export function isKnownTool(name: string): boolean {
  return TOOL_NAMES.has(name);
}

type Args = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  return fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function minutesArg(args: Args): number | undefined {
  const value = args.minutes;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.min(Math.floor(value), 43200);
  }
  return undefined;
}

function sourceArg(args: Args, store: LogStore): string | undefined {
  const source = asString(args.source);
  if (source && !store.hasSource(source)) {
    throw new Error(
      `Unknown source "${source}". Known sources: ${store.sourceNames.join(", ") || "none"}. Call list_sources to see them.`,
    );
  }
  return source;
}

function windowEntries(args: Args, store: LogStore): LogEntry[] {
  const source = sourceArg(args, store);
  return store.filter({ source, minutes: minutesArg(args) });
}

function publicEntry(entry: LogEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    timestamp: entry.timestampRaw,
    level: entry.level,
    source: entry.source,
    message: entry.message,
  };
  if (entry.status !== undefined) out.status = entry.status;
  if (entry.route !== undefined) out.route = entry.route;
  if (entry.method !== undefined) out.method = entry.method;
  if (entry.latencyMs !== undefined) out.latency_ms = entry.latencyMs;
  if (!entry.parsed) out.unparsed = true;
  return out;
}

function listSources(store: LogStore): unknown {
  const sources = store.listSources();
  return {
    sources,
    errors: store.sourceErrors(),
    note:
      sources.length === 0
        ? "No log files are configured. Pass file paths as arguments, set RUDOW_LOCAL_LOG_PATHS, or add a rudow-local.json config file. See the README."
        : undefined,
  };
}

function queryLogs(args: Args, store: LogStore): unknown {
  const level = asString(args.level);
  const validLevels = ["debug", "info", "warn", "error", "fatal"];
  if (level && !validLevels.includes(level)) {
    throw new Error(`Invalid level "${level}". Use one of: ${validLevels.join(", ")}.`);
  }
  const limit = clamp(asInt(args.limit, 50), 1, 200);
  const entries = store.filter({
    level: level as LogEntry["level"] | undefined,
    source: sourceArg(args, store),
    text: asString(args.text),
    minutes: minutesArg(args),
    beforeIso: asString(args.before_iso),
  });
  const page = store.newestFirst(entries, limit);
  return {
    totalMatching: entries.length,
    returned: page.length,
    entries: page.map(publicEntry),
  };
}

function queryLogsBatched(args: Args, store: LogStore): unknown {
  const minutes = minutesArg(args) ?? 60;
  const bucketMinutes = clamp(asInt(args.bucket_minutes, 5), 1, 1440);
  const perBucket = clamp(asInt(args.per_bucket, 20), 1, 100);
  const limit = clamp(asInt(args.limit, 400), 1, 1000);
  const source = sourceArg(args, store);
  const text = asString(args.text);

  const newest = store.newestTimestamp();
  const entries = store.filter({ source, text, minutes });
  const stamped = entries.filter((e) => e.timestamp !== null);
  const unstamped = entries.filter((e) => e.timestamp === null);

  const buckets: { bucketStart: string; entries: unknown[] }[] = [];
  if (newest && stamped.length > 0) {
    const widthMs = bucketMinutes * 60_000;
    const end = newest.getTime();
    const start = end - minutes * 60_000;
    const count = Math.max(1, Math.ceil((end - start) / widthMs));
    for (let i = 0; i < count; i += 1) {
      const bucketStart = start + i * widthMs;
      const bucketEnd = bucketStart + widthMs;
      const inBucket = stamped
        .filter((e) => {
          const t = (e.timestamp as Date).getTime();
          return t >= bucketStart && t < bucketEnd;
        })
        .slice(0, perBucket);
      buckets.push({
        bucketStart: new Date(bucketStart).toISOString(),
        entries: inBucket.map(publicEntry),
      });
    }
  }
  const out = buckets.flatMap((b) => b.entries).slice(0, limit);
  if (unstamped.length > 0) {
    out.push(...unstamped.slice(0, perBucket).map(publicEntry));
  }
  return {
    totalMatching: entries.length,
    returned: out.slice(0, limit).length,
    buckets: buckets.map((b) => ({ bucketStart: b.bucketStart, count: b.entries.length })),
    entries: out.slice(0, limit),
  };
}

function aggregateLogs(args: Args, store: LogStore): unknown {
  const groupBy = asString(args.group_by);
  const valid = ["level", "source", "status", "route"];
  if (!groupBy || !valid.includes(groupBy)) {
    throw new Error(`group_by is required. Use one of: ${valid.join(", ")}.`);
  }
  const entries = windowEntries(args, store);
  let groups: Record<string, number>;
  if (groupBy === "level") groups = levelCounts(entries);
  else if (groupBy === "status") groups = statusCounts(entries);
  else if (groupBy === "route") {
    groups = {};
    for (const entry of entries) {
      if (!entry.route) continue;
      groups[entry.route] = (groups[entry.route] ?? 0) + 1;
    }
  } else {
    groups = {};
    for (const entry of entries) {
      groups[entry.source] = (groups[entry.source] ?? 0) + 1;
    }
  }
  const sorted = Object.entries(groups)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
  return { group_by: groupBy, total: entries.length, groups: sorted };
}

function summaryBody(entries: LogEntry[]): Record<string, unknown> {
  const lat = latencyStats(entries);
  const routes = routeStats(entries);
  return {
    totalEntries: entries.length,
    errorCount: entries.filter((e) => e.level === "error" || e.level === "fatal").length,
    errorRate: round(errorRate(entries), 4),
    latency: lat.count > 0 ? lat : null,
    latencyNote:
      lat.count === 0
        ? "No latency data in these entries, so latency figures are not available."
        : `${lat.count} entries carry latency data.`,
    topRoutes: routes.slice(0, 5),
    topErrorRoutes: routes.filter((r) => r.errors > 0).sort((a, b) => b.errors - a.errors).slice(0, 5),
    topErrors: topErrors(entries, 5),
  };
}

function metricsSummary(args: Args, store: LogStore): unknown {
  const entries = windowEntries(args, store);
  return { ...summaryBody(entries), minutes: minutesArg(args) ?? 60 };
}

function metricsOverview(args: Args, store: LogStore): unknown {
  const entries = windowEntries(args, store);
  const lat = latencyStats(entries);
  const routes = routeStats(entries);
  return {
    totalEntries: entries.length,
    errorCount: entries.filter((e) => e.level === "error" || e.level === "fatal").length,
    errorRate: round(errorRate(entries), 4),
    averageLatencyMs: lat.averageMs,
    p95LatencyMs: lat.p95Ms,
    latencyEntries: lat.count,
    topErrorRoutes: routes.filter((r) => r.errors > 0).sort((a, b) => b.errors - a.errors).slice(0, 5),
  };
}

function metricsTrends(args: Args, store: LogStore): unknown {
  const entries = windowEntries(args, store);
  return { minutes: minutesArg(args) ?? 60, buckets: trends(entries, 12) };
}

function metricsDistributions(args: Args, store: LogStore): unknown {
  const entries = windowEntries(args, store);
  const lat = latencyStats(entries);
  return {
    latencyEntries: lat.count,
    p50Ms: lat.p50Ms,
    p75Ms: lat.p75Ms,
    p90Ms: lat.p90Ms,
    p95Ms: lat.p95Ms,
    p99Ms: lat.p99Ms,
    histogram: latencyHistogram(entries),
    note:
      lat.count === 0
        ? "No latency data in these entries, so no distribution is available."
        : undefined,
  };
}

function metricsRoutes(args: Args, store: LogStore): unknown {
  const entries = windowEntries(args, store);
  const routes = routeStats(entries);
  return {
    totalEntries: entries.length,
    routes: routes.slice(0, 20),
    note:
      routes.length === 0
        ? "No entries carry a route, so no route breakdown is available."
        : undefined,
  };
}

function metricsLevels(args: Args, store: LogStore): unknown {
  const entries = windowEntries(args, store);
  const counts = levelCounts(entries);
  const levels = ["debug", "info", "warn", "error", "fatal", "unknown"];
  return {
    totalEntries: entries.length,
    levels: levels
      .filter((level) => counts[level] !== undefined)
      .map((level) => ({
        level,
        count: counts[level],
        share: entries.length > 0 ? round(counts[level] / entries.length, 4) : 0,
      })),
  };
}

function routeDrilldown(args: Args, store: LogStore): unknown {
  const route = asString(args.route);
  if (!route) throw new Error("route is required, e.g. '/api/checkout'.");
  const entries = windowEntries(args, store).filter((e) => e.route === route);
  const lat = latencyStats(entries);
  return {
    route,
    requests: entries.length,
    errorCount: entries.filter((e) => e.level === "error" || e.level === "fatal").length,
    errorRate: round(errorRate(entries), 4),
    averageLatencyMs: lat.averageMs,
    p95LatencyMs: lat.p95Ms,
    errorsByStatus: statusCounts(entries.filter((e) => e.level === "error" || e.level === "fatal")),
    topErrors: topErrors(entries, 5),
  };
}

function fetchWindow(args: Args, store: LogStore): unknown {
  const aroundIso = asString(args.around_iso);
  if (!aroundIso) throw new Error("around_iso is required, e.g. '2026-11-27T09:20:00Z'.");
  const around = new Date(aroundIso);
  if (Number.isNaN(around.getTime())) {
    throw new Error(`Could not parse around_iso "${aroundIso}" as a timestamp.`);
  }
  const n = clamp(asInt(args.n, 10), 1, 50);
  const source = sourceArg(args, store);
  const entries = store.chronological(store.filter({ source }));
  const stamped = entries.filter((e) => e.timestamp !== null);
  if (stamped.length === 0) {
    return { around_iso: aroundIso, before: [], after: [], note: "No timestamped entries in these sources." };
  }
  let closest = 0;
  let closestDiff = Number.POSITIVE_INFINITY;
  stamped.forEach((entry, i) => {
    const diff = Math.abs((entry.timestamp as Date).getTime() - around.getTime());
    if (diff < closestDiff) {
      closestDiff = diff;
      closest = i;
    }
  });
  const before = stamped.slice(Math.max(0, closest - n), closest).map(publicEntry);
  const after = stamped.slice(closest, closest + n + 1).map(publicEntry);
  return {
    around_iso: aroundIso,
    closestEntryAt: (stamped[closest].timestamp as Date).toISOString(),
    before,
    after,
  };
}

function listIncidents(args: Args, store: LogStore): unknown {
  const status = asString(args.status);
  const source = sourceArg(args, store);
  if (status === "resolved") return { incidents: [] };
  if (status && status !== "open") {
    throw new Error(`Invalid status "${status}". Use "open" or "resolved".`);
  }
  const all = detectIncidents(store.allEntries());
  const filtered = source ? all.filter((i) => i.source === source) : all;
  return {
    incidents: filtered.map((i) => ({
      id: i.id,
      source: i.source,
      title: i.title,
      status: i.status,
      startedAt: i.startedAt,
      endedAt: i.endedAt,
      entryCount: i.entryCount,
      signals: i.signals,
    })),
  };
}

function getIncident(args: Args, store: LogStore): unknown {
  const incidentId = asString(args.incident_id);
  if (!incidentId) throw new Error("incident_id is required.");
  const source = sourceArg(args, store);
  const all = detectIncidents(store.allEntries());
  const found = all.find(
    (i) => i.id === incidentId && (!source || i.source === source),
  );
  if (!found) {
    throw new Error(`No incident with id "${incidentId}" was found in the loaded logs.`);
  }
  return found;
}

export function handleTool(name: string, args: Args, store: LogStore): unknown {
  switch (name) {
    case "list_sources":
      return listSources(store);
    case "query_logs":
      return queryLogs(args, store);
    case "query_logs_batched":
      return queryLogsBatched(args, store);
    case "aggregate_logs":
      return aggregateLogs(args, store);
    case "metrics_summary":
      return metricsSummary(args, store);
    case "metrics_overview":
      return metricsOverview(args, store);
    case "metrics_trends":
      return metricsTrends(args, store);
    case "metrics_distributions":
      return metricsDistributions(args, store);
    case "metrics_routes":
      return metricsRoutes(args, store);
    case "metrics_levels":
      return metricsLevels(args, store);
    case "route_drilldown":
      return routeDrilldown(args, store);
    case "fetch_window":
      return fetchWindow(args, store);
    case "list_incidents":
      return listIncidents(args, store);
    case "get_incident":
      return getIncident(args, store);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
